import * as THREE from 'three';
import { Vector3 } from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { diceSurf } from './mesh.js';

////////////////////////////////////////////////////////////////////////////////
// Basis

const fontLoader = new FontLoader();
let font = null;

const debug = {
    strict: false, // should raise exception at logic boundary even when it can continue.
};

// orange-teal-purple color palette for ABC axes.
const axisColorA = new THREE.Color(0xe67e22);
const axisColorB = new THREE.Color(0x1abc9c);
const axisColorC = new THREE.Color(0x9b59b6);


const createCylinderVis = (p, n, r, col) => {
    // Cylinder lies along Y axis, centered at origin.
    const geom = new THREE.CylinderGeometry(r, r, 30, 8);
    const mat = new THREE.MeshBasicMaterial({ color: col, wireframe: true });
    const mesh = new THREE.Mesh(geom, mat);
    
    const rotV = new THREE.Vector3(0, 1, 0).cross(n);
    if (rotV.length() > 1e-6) {
        mesh.setRotationFromAxisAngle(rotV.clone().normalize(), Math.asin(rotV.length()));
    }
    mesh.position.copy(n.clone().multiplyScalar(15).add(p));
    return mesh;
};

// Create a sphere visualizer for error location.
// [in] p THREE.Vector3, location in work coords.
// [in] col THREE.Color, color
// returns: THREE.Mesh
const createErrorLocVis = (p, col) => {
    const sphGeom = new THREE.SphereGeometry(0.1);
    const sphMat = new THREE.MeshBasicMaterial({ color: col });
    const sph = new THREE.Mesh(sphGeom, sphMat);
    sph.position.copy(p);
    return sph;
}

// Create a text visualizer.
// [in] p THREE.Vector3, location in work coords.
// [in] text string
// [in] size number, text size
// [in] color THREE.Color
// returns: THREE.Mesh
const createTextVis = (p, text, size=0.25, color="#222222") => {
    const textGeom = new TextGeometry(text, {
        font,
        size,
        depth: 0.1,
    });
    const textMesh = new THREE.Mesh(textGeom, new THREE.MeshBasicMaterial({ color }));
    textMesh.position.copy(p);
    return textMesh;
};


// Creates ring+axis rotational axis visualizer.
// [in] axis THREE.Vector3. rotates around this axis in CCW.
// [in] size number feature size. typically ring radius.
// [in] color THREE.Color
// returns: THREE.Object3D
const createRotationAxisHelper = (axis, size = 1, color = axisColorA) => {
    const NUM_RING_PTS = 32;

    /////
    // contsutuct axis & ring out of line segments

    // Generate as Z+ axis, scale=1 and rotate & re-scale later.
    const buffer = new THREE.BufferGeometry();
    const pts = [];
    // add axis
    pts.push(0, 0, -1);
    pts.push(0, 0, 1);
    // add ring
    for (let i = 0; i < NUM_RING_PTS; i++) {
        const angle0 = 2 * Math.PI * i / NUM_RING_PTS;
        const angle1 = 2 * Math.PI * (i + 1) / NUM_RING_PTS;
        pts.push(Math.cos(angle0), Math.sin(angle0), 0);
        pts.push(Math.cos(angle1), Math.sin(angle1), 0);
    }
    buffer.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    const lineSegs = new THREE.LineSegments(buffer, new THREE.LineBasicMaterial({ color }));

    /////
    // construct direction cones
    const geom = new THREE.ConeGeometry(0.1, 0.2);
    const coneMat = new THREE.MeshBasicMaterial({ color });
    const cone0 = new THREE.Mesh(geom, coneMat);
    const cone1 = new THREE.Mesh(geom, coneMat);
    
    const localHelper = new THREE.Object3D();
    localHelper.add(lineSegs);
    localHelper.add(cone0);
    cone0.position.set(0.99, 0, 0);

    localHelper.add(cone1);
    cone1.scale.set(1, -1, 1);
    cone1.position.set(-0.99, 0, 0);

    ///// 
    // scale & rotate

    // create orthonormal basis for rotation.
    const basisZ = axis.normalize();
    let basisY;
    const b0 = new THREE.Vector3(1, 0, 0);
    const b1 = new THREE.Vector3(0, 1, 0);
    if (b0.clone().cross(basisZ).length() > 0.3) {
        basisY = b0.clone().cross(basisZ).normalize();
    } else {
        basisY = b1.clone().cross(basisZ).normalize();
    }
    const basisX = basisY.clone().cross(basisZ).normalize();

    // init new grid
    const lToWMat3 = new THREE.Matrix3(
        basisX.x, basisY.x, basisZ.x,
        basisX.y, basisY.y, basisZ.y,
        basisX.z, basisY.z, basisZ.z,
    );

    const helper = new THREE.Object3D();
    helper.add(localHelper);

    localHelper.scale.set(size, size, size);
    localHelper.applyMatrix4(new THREE.Matrix4().identity().setFromMatrix3(lToWMat3));
    return helper;
};



////////////////////////////////////////////////////////////////////////////////
// Planner Module

const TG_FULL = 0; // fully occupied
const TG_PARTIAL = 1; // partially occupied
const TG_EMPTY = 2; // empty

const W_REMAINING = 0; // remaining work
const W_DONE = 1; // work done

const C_FULL_DONE = 0;  // current=full
const C_EMPTY_DONE = 1;  // current=empty
const C_EMPTY_REMAINING = 2; // current=non-empty
const C_PARTIAL_DONE = 3; // current=partial
const C_PARTIAL_REMAINING = 4; // current=full


// see https://iquilezles.org/articles/distfunctions/ for SDFs in general.

// Returns a SDF for a cylinder.
// [in] p: start point
// [in] n: direction (the cylinder extends infinitely towards n+ direction)
// [in] r: radius
// returns: SDF: THREE.Vector3 -> number (+: outside, 0: surface, -: inside)
const createSdfCylinder = (p, n, r) => {
    if (n.length() !== 1) {
        throw "Cylinder direction not normalized";
    }
    const temp = new Vector3();
    const sdf = x => {
        const dx = temp.copy(x).sub(p);

        // decompose into 1D + 2D
        const dx1 = dx.dot(n);
        const dx2 = dx.projectOnPlane(n); // destroys dx

        // 1D distance from interval [0, +inf)
        const d1 = -dx1;

        // 2D distance from a circle r.
        const d2 = dx2.length() - r;

        // Combine 1D + 2D distances.
        return Math.min(Math.max(d1, d2), 0) + Math.hypot(Math.max(d1, 0), Math.max(d2, 0));
    };
    return sdf;
};

// Returns a SDF for ELH (extruded long hole).
//
// [in] p: start point
// [in] q: end point
// [in] n: direction (p-q must be perpendicular to n). LH is extruded along n+, by h.
// [in] r: radius (>= 0)
// [in] h: height (>= 0)
// returns: SDF: THREE.Vector3 -> number (+: outside, 0: surface, -: inside)
const createSdfElh = (p, q, n, r, h) => {
    if (n.length() !== 1) {
        throw "ELH direction not normalized";
    }
    if (q.clone().sub(p).dot(n) !== 0) {
        throw "Invalid extrusion normal";
    }
    if (q.distanceTo(p) < 0) {
        throw "Invalid p-q pair";
    }
    const dq = q.clone().sub(p);
    const dqLenSq = dq.dot(dq);
    const clamp01 = x => {
        return Math.max(0, Math.min(1, x));
    };

    const temp = new Vector3();
    const temp2 = new Vector3();
    const sdf = x => {
        const dx = temp.copy(x).sub(p);

        // decompose into 2D + 1D
        const dx1 = n.dot(dx);
        const dx2 = dx.projectOnPlane(n); // destroys dx

        // 1D distance from interval [0, h]
        const d1 = Math.abs(dx1 - h * 0.5) - h * 0.5;

        // 2D distance from long hole (0,dq,r)
        const t = clamp01(dx2.dot(dq) / dqLenSq); // limit to line segment (between p & q)
        const d2 = dx2.distanceTo(temp2.copy(dq).multiplyScalar(t)) - r;

        // Combine 1D + 2D distances.
        return Math.min(Math.max(d1, d2), 0) + Math.hypot(Math.max(d1, 0), Math.max(d2, 0));
    };
    return sdf;
};

// Traverse all points that (sdf(p) <= offset), and call fn(ix, iy, iz).
//
// [in] vg: VoxelGrid or TrackingVoxelGrid (must implement numX, numY, numZ, res, ofs, centerOf)
// [in] sdf: number => number. Must be "true" SDF for this to work correctly.
// [in] offset: offset
// [in] fn: function(ix, iy, iz) => boolean. If true, stop traversal and return true.
// returns: boolean. If true, stop traversal and return true.
const traverseAllPointsInside = (vg, sdf, offset, fn) => {
    const blockSize = 8;
    const nbx = Math.floor(vg.numX / blockSize) + 1;
    const nby = Math.floor(vg.numY / blockSize) + 1;
    const nbz = Math.floor(vg.numZ / blockSize) + 1;

    const blockOffset = vg.res * blockSize * 0.5 * Math.sqrt(3);
    const blocks = [];
    for (let bz = 0; bz < nbz; bz++) {
        for (let by = 0; by < nby; by++) {
            for (let bx = 0; bx < nbx; bx++) {
                const blockCenter = new Vector3(bx, by, bz).addScalar(0.5).multiplyScalar(blockSize * vg.res).add(vg.ofs);
                if (sdf(blockCenter) <= blockOffset + offset) {
                    blocks.push({bx, by, bz});
                }
            }
        }
    }

    for (let i = 0; i < blocks.length; i++) {
        for (let dz = 0; dz < blockSize; dz++) {
            const iz = blocks[i].bz * blockSize + dz;
            if (iz >= vg.numZ) {
                continue;
            }
            for (let dy = 0; dy < blockSize; dy++) {
                const iy = blocks[i].by * blockSize + dy;
                if (iy >= vg.numY) {
                    continue;
                }
                for (let dx = 0; dx < blockSize; dx++) {
                    const ix = blocks[i].bx * blockSize + dx;
                    if (ix >= vg.numX) {
                        continue;
                    }

                    if (sdf(vg.centerOf(ix, iy, iz)) <= offset) {
                        if (fn(ix, iy, iz)) {
                            return true;
                        }
                    }
                }
            }
        }
    }
    return false;
};

// Returns true if all points (sdf(p) <= offset) are pred(p).
//
// [in] vg: VoxelGrid or TrackingVoxelGrid (must implement numX, numY, numZ, res, ofs, centerOf)
// [in] sdf: number => number
// [in] offset: offset
// [in] pred: function(ix, iy, iz) => boolean.
// returns: boolean. If true, stop traversal and return true.
const everyPointInsideIs = (vg, sdf, offset, pred) => {
    return !traverseAllPointsInside(vg, sdf, offset, (ix, iy, iz) => {
        return !pred(ix, iy, iz);
    });
};

const anyPointInsideIs = (vg, sdf, offset, pred) => {
    return traverseAllPointsInside(vg, sdf, offset, (ix, iy, iz) => {
        return pred(ix, iy, iz);
    });
};


// Generic voxel grid
// voxel-local coordinate
// voxel at (ix, iy, iz):
// * occupies volume: [i * res, (i + 1) * res)
// * has center: (i + 0.5) * res
//
// loc_world = loc_vx + ofs
class VoxelGrid {
    // [in] res: voxel resolution
    // [in] numX, numY, numZ: grid dimensions
    // [in] ofs: voxel grid offset (local to world)
    constructor(res, numX, numY, numZ, ofs = new Vector3()) {
        this.res = res;
        this.numX = numX;
        this.numY = numY;
        this.numZ = numZ;
        this.data = new Uint8Array(numX * numY * numZ);
        this.ofs = ofs.clone();
    }

    clone() {
        const vg = new VoxelGrid(this.res, this.numX, this.numY, this.numZ, this.ofs);
        vg.data.set(this.data);
        return vg;
    }

    // Set cells inside the "extruded long hole" shape to val.
    //
    // [in] p, q: start & end of the hole, in world coordinates
    // [in] n: normal of the hole extrusion, in world coordinates. Must be perpendicular to p-q line.
    // [in] r: radius of the hole
    // [in] val: value to set to cells
    // [in] roundToOutside: if true, round to outside of the hole. Otherwise, round to inside.
    setExtrudedLongHole(p, q, n, r, val, roundToOutside) {        
        const sdf = createSdfElh(p, q, n, r, 100);
        const offset = (roundToOutside ? 1 : -1) * (this.res * 0.5 * Math.sqrt(3));

        traverseAllPointsInside(this, sdf, offset, (ix, iy, iz) => {
            this.set(ix, iy, iz, val);
        });
    }

    /////
    // read/write
    fill(val) {
        this.data.fill(val);
        return this;
    }

    set(ix, iy, iz, val) {
        this.data[ix + iy * this.numX + iz * this.numX * this.numY] = val;
    }

    get(ix, iy, iz) {
        return this.data[ix + iy * this.numX + iz * this.numX * this.numY];
    }

    count() {
        let cnt = 0;
        for (let i = 0; i < this.data.length; i++) {
            if (this.data[i] !== 0) {
                cnt++;
            }
        }
        return cnt;
    }

    countEq(val) {
        let cnt = 0;
        for (let i = 0; i < this.data.length; i++) {
            if (this.data[i] === val) {
                cnt++;
            }
        }
        return cnt;
    }

    //////
    // spatial op

    volume() {
        return this.count() * this.res * this.res * this.res;
    }

    centerOf(ix, iy, iz) {
        return new Vector3(ix, iy, iz).addScalar(0.5).multiplyScalar(this.res).add(this.ofs);
    }
}


// Represents current work & target.
// The class ensures that work is bigger than target.
//
// voxel-local coordinate
// voxel at (ix, iy, iz):
// * occupies volume: [i * res, (i + 1) * res)
// * has center: (i + 0.5) * res
//
// loc_world = loc_vx + ofs
//
// Each cell {
//   target: {Full, Partial, Empty}
//   work: {Remaining, Done} (Done if target == Full)
// }
class TrackingVoxelGrid {
    // [in] res: voxel resolution
    // [in] numX, numY, numZ: grid dimensions
    // [in] ofs: voxel grid offset (local to world)
    constructor(res, numX, numY, numZ, ofs = new Vector3()) {
        this.res = res;
        this.numX = numX;
        this.numY = numY;
        this.numZ = numZ;
        this.dataW = new Uint8Array(numX * numY * numZ);
        this.dataT = new Uint8Array(numX * numY * numZ);
        this.ofs = ofs.clone();
    }

    clone() {
        const vg = new TrackingVoxelGrid(this.res, this.numX, this.numY, this.numZ, this.ofs.clone());
        vg.dataW.set(this.dataW);
        vg.dataT.set(this.dataT);
        return vg;
    }

    // Scaffold for refactoring.
    // [in] work: VoxelGrid (0: empty, 128: partial, 255: full)
    // [in] target: VoxelGrid (0: empty, 128: partial, 255: full)
    setFromWorkAndTarget(work, target) {
        for (let i = 0; i < this.dataW.length; i++) {
            let tst = null;
            switch(target.data[i]) {
                case 0:
                    tst = TG_EMPTY;
                    break;
                case 128:
                    tst = TG_PARTIAL;
                    break;
                case 255:
                    tst = TG_FULL;
                    break;
                default:
                    throw `Unknown target value: ${target.data[i]}`;
            }
            this.dataT[i] = tst;

            switch(work.data[i]) {
                case 0: // empty
                    if (tst !== TG_EMPTY) {
                        throw `Unachievable target: target=${tst}, work=empty`;
                    }
                    this.dataW[i] = W_DONE;
                    break;
                case 128: // partial
                    if (tst !== TG_EMPTY) {
                        throw `(Possibly) unachievable target: target=${tst}, work=partial`;
                    }
                    this.dataW[i] = W_REMAINING;
                    break;
                case 255: // full
                    this.dataW[i] = (tst === TG_FULL) ? W_DONE : W_REMAINING;
                    break;
                default:
                    throw `Unknown work value: ${work.data[i]}`;
            }
        }
    }

    // Scaffold for refactoring.
    // returns: VoxelGrid (0: empty, 255: full)
    extractWork() {
        const res = new VoxelGrid(this.res, this.numX, this.numY, this.numZ, this.ofs);
        for (let i = 0; i < this.dataW.length; i++) {
            res.data[i] = this.dataW[i] === W_REMAINING ? 255 : 0;
        }
        return res;
    }

    // Scaffold for refactoring.
    // returns: VoxelGrid (0: empty, 128: partial, 255: full)
    extractTarget() {
        const res = new VoxelGrid(this.res, this.numX, this.numY, this.numZ, this.ofs);
        for (let i = 0; i < this.dataT.length; i++) {
            res.data[i] = this.dataT[i] === TG_FULL ? 255 : (this.dataT[i] === TG_PARTIAL ? 128 : 0);
        }
        return res;
    }

    // Commit (rough) removal of minGeom and maxGeom.
    // maxGeom >= minGeom must hold. otherwise, throw error.
    //
    // Rough removal means, this cut can process TG_EMPTY cells, but not TG_PARTIAL cells.
    // When cut can potentially affect TG_PARTIAL cells, it will be error (as rough cut might ruin the voxel irreversibly).
    //
    // [in] minGeoms: array of shape descriptor, treated as union of all shapes.
    // [in] maxGeoms: array of shape descriptor, treated as union of all shapes
    // returns: volume of neewly removed work.
    commitRemoval(minGeoms, maxGeoms) {
        const minVg = new VoxelGrid(this.res, this.numX, this.numY, this.numZ, this.ofs);
        const maxVg = new VoxelGrid(this.res, this.numX, this.numY, this.numZ, this.ofs);
        minGeoms.forEach(g => {
            minVg.setExtrudedLongHole(g.p, g.q, g.n, g.r, 255, false);
        });
        maxGeoms.forEach(g => {
            maxVg.setExtrudedLongHole(g.p, g.q, g.n, g.r, 255, true);
        });

        let numDamages = 0;
        let numRemoved = 0;
        for (let z = 0; z < this.numZ; z++) {
            for (let y = 0; y < this.numY; y++) {
                for (let x = 0; x < this.numX; x++) {
                    const isInMax = maxVg.get(x, y, z) > 0;
                    const isInMin = minVg.get(x, y, z) > 0;
                    if (isInMin && !isInMax) {
                        const p = this.centerOf(x, y, z);
                        const locator = `ix=(${x},${y},${z}), p=(${p.x},${p.y},${p.z})`;
                        throw `Min/max reversal, at ${locator}`;
                    }

                    const i = x + y * this.numX + z * this.numX * this.numY;
                    const isTargetNotEmpty = this.dataT[i] !== TG_EMPTY;                    

                    // Commit.
                    if (isInMax) {
                        // this voxel can be potentially uncertainly removed.
                        if (isTargetNotEmpty) {
                            debug.vlogE(createErrorLocVis(this.centerOf(x, y, z), "violet"));
                            numDamages++;
                        }
                    }
                    
                    if (isInMin) {
                        // this voxel will be definitely completely removed.
                        // (at this point. dataT === TG_EMPTY, because isMin => isMax.)
                        if (this.dataW[i] === W_REMAINING) {
                            this.dataW[i] = W_DONE;
                            numRemoved++;
                        }
                    }
                }
            }
        }
        if (debug.strict && numDamages > 0) {
            throw `${numDamages} cells are potentially damaged`;
        }
        return numRemoved * this.res * this.res * this.res;
    }

    // returns volume of remaining work.
    getRemainingWorkVol() {
        let cnt = 0;
        for (let i = 0; i < this.dataW.length; i++) {
            if (this.dataW[i] === W_REMAINING) {
                cnt++;
            }
        }
        return cnt * this.res * this.res * this.res;
    }

    // Returns offset of the work in normal direction conservatively.
    // Conservative means: "no-work" region never has work, despite presence of quantization error.
    //
    // [in] normal THREE.Vector3, work coords.
    // returns: number, offset. No work exists in + side of the plane. normal * offset is on the plane.
    queryWorkOffset(normal) {
        let offset = -Infinity;
        for (let iz = 0; iz < this.numZ; iz++) {
            for (let iy = 0; iy < this.numY; iy++) {
                for (let ix = 0; ix < this.numX; ix++) {
                    if (this.getW(ix, iy, iz) === W_REMAINING) {
                        const t = this.centerOf(ix, iy, iz).dot(normal);
                        offset = Math.max(offset, t);
                    }
                }
            }
        }
        const maxVoxelCenterOfs = this.res * Math.sqrt(3) * 0.5;
        return offset + maxVoxelCenterOfs;
    }

    // Returns true if given semi-infinite cylinder is blocked by material, conservatively.
    // Conservative: voxels with potential overlaps will be considered for block-detection.
    //
    // [in] p: start point
    // [in] n: direction (the cylinder extends infinitely towards n+ direction)
    // [in] r: radius
    // returns: true if blocked, false otherwise
    queryBlockedCylinder(p, n, r) {
        const sdf = createSdfCylinder(p, n, r);
        const margin = this.res * 0.5 * Math.sqrt(3);

        return anyPointInsideIs(this, sdf, margin, (ix, iy, iz) => {
            return this.get(ix, iy, iz) !== C_EMPTY_DONE;
        });
    }

    // Returns true if given ELH is blocked by material, conservatively.
    // Conservative: voxels with potential overlaps will be considered for block-detection.
    //
    // [in] p: start point
    // [in] q: end point
    // [in] n: direction (p-q must be perpendicular to n). LH is extruded along n+, by h.
    // [in] r: radius (>= 0)
    // [in] h: height (>= 0)
    // returns: true if blocked, false otherwise
    queryBlockedELH(p, q, n, r, h) {
        const sdf = createSdfElh(p, q, n, r, h);
        const margin = this.res * 0.5 * Math.sqrt(3);

        return anyPointInsideIs(this, sdf, margin, (ix, iy, iz) => {
            return this.get(ix, iy, iz) !== C_EMPTY_DONE;
        });
    }

    // Returns true if given ELH is accessible for work, conservatively.
    // accessible for work: work won't accidentally destroy protected region && region contains work.
    //
    // [in] p: start point
    // [in] q: end point
    // [in] n: direction (p-q must be perpendicular to n). LH is extruded along n+, by h.
    // [in] r: radius (>= 0)
    // [in] hWork: height of work region (>= 0)
    // [in] hCollateral: height of collateral region (>= 0)
    // returns: true if accessible, false otherwise
    queryOkToCutELH(p, q, n, r, hWork, hCollateral) {
        const sdfWork = createSdfElh(p, q, n, r, hWork);
        const sdfCollateral = createSdfElh(p, q, n, r, hCollateral);
        const margin = this.res * 0.5 * Math.sqrt(3);

        return everyPointInsideIs(this, sdfCollateral, margin, (ix, iy, iz) => {
            const st = this.get(ix, iy, iz);
            return st === C_EMPTY_DONE || st === C_EMPTY_REMAINING;
        }) && anyPointInsideIs(this, sdfWork, margin, (ix, iy, iz) => {
            return this.getW(ix, iy, iz) === W_REMAINING;
        });
    }

    queryOkToCutCylinder(p, n, r) {
        const sdf = createSdfCylinder(p, n, r);
        const margin = this.res * 0.5 * Math.sqrt(3);

        return everyPointInsideIs(this, sdf, margin, (ix, iy, iz) => {
            const st = this.get(ix, iy, iz);
            return st === C_EMPTY_DONE || st === C_EMPTY_REMAINING;
        }) && anyPointInsideIs(this, sdf, margin, (ix, iy, iz) => {
            return this.getW(ix, iy, iz) === W_REMAINING;
        });
    }

    /////
    // Single read/write

    // [in] ix, iy, iz: voxel index
    // returns: voxel value. One of C_FULL_DONE, C_EMPTY_DONE, C_EMPTY_REMAINING, C_PARTIAL_DONE, C_PARTIAL_REMAINING.
    get(ix, iy, iz) {
        const t = this.dataT[ix + iy * this.numX + iz * this.numX * this.numY];
        const w = this.dataW[ix + iy * this.numX + iz * this.numX * this.numY];

        switch (t) {
            case TG_FULL:
                return C_FULL_DONE;
            case TG_EMPTY:
                return w === W_DONE ? C_EMPTY_DONE : C_EMPTY_REMAINING;
            case TG_PARTIAL:
                return w === W_DONE ? C_PARTIAL_DONE : C_PARTIAL_REMAINING;
        }
        throw `Invalid cell state T=${t}, W=${w}`;
    }

    // [in] ix, iy, iz: voxel index
    // returns: one of W_REMAINING, or W_DONE
    getW(ix, iy, iz) {
        return this.dataW[ix + iy * this.numX + iz * this.numX * this.numY];
    }

    // [in] ix, iy, iz: voxel index
    // returns: one of TG_FULL, TG_PARTIAL, TG_EMPTY
    getT(ix, iy, iz) {
        return this.dataT[ix + iy * this.numX + iz * this.numX * this.numY];
    }

    //////
    // spatial op

    centerOf(ix, iy, iz) {
        return new Vector3(ix, iy, iz).addScalar(0.5).multiplyScalar(this.res).add(this.ofs);
    }
}

// Computes AABB for bunch of points.
// [in] pts: [x0, y0, z0, x1, y1, z1, ...]
// returns: {min: Vector3, max: Vector3}
const computeAABB = (pts) => {
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < pts.length; i += 3) {
        const v = new THREE.Vector3(pts[i + 0], pts[i + 1], pts[i + 2]);
        min.min(v);
        max.max(v);
    }
    return { min, max };
};

// Initialize voxel grid for storing points.
// [in] pts: [x0, y0, z0, x1, y1, z1, ...]
// [in] resMm: voxel resolution
// returns: VoxelGrid
const initVGForPoints = (pts, resMm) => {
    const MARGIN_MM = 1;
    const { min, max } = computeAABB(pts);
    const center = min.clone().add(max).divideScalar(2);
    
    min.subScalar(MARGIN_MM);
    max.addScalar(MARGIN_MM);

    const numV = max.clone().sub(min).divideScalar(resMm).ceil();
    const gridMin = center.clone().sub(numV.clone().multiplyScalar(resMm / 2));
    return new VoxelGrid(resMm, numV.x, numV.y, numV.z, gridMin);
};

// Apply translation to geometry in-place.
// [in]: THREE.BufferGeometry
// [in]: THREE.Vector3
const translateGeom = (geom, trans) => {
    const pos = geom.getAttribute("position").array;
    for (let i = 0; i < pos.length; i += 3) {
        pos[i + 0] += trans.x;
        pos[i + 1] += trans.y;
        pos[i + 2] += trans.z;
    }
};


// Get "triangle soup" representation from a geometry.
// [in]: THREE.BufferGeometry
// returns: TypedArray
const convGeomToSurf = (geom) => {
    if (geom.index === null) {
        return geom.getAttribute("position").array;
    } else {
        const ix = geom.index.array;
        const pos = geom.getAttribute("position").array;

        const numTris = ix.length / 3;
        const buf = new Float32Array(numTris * 9);
        for (let i = 0; i < numTris; i++) {
            for (let v = 0; v < 3; v++) {
                const vIx = ix[3 * i + v];
                buf[9 * i + 3 * v + 0] = pos[3 * vIx + 0];
                buf[9 * i + 3 * v + 1] = pos[3 * vIx + 1];
                buf[9 * i + 3 * v + 2] = pos[3 * vIx + 2];
            }
        }
        return buf;
    }
};


// returns: THREE.BufferGeometry
const generateStockGeom = () => {
    const stockRadius = 7.5;
    const stockHeight = 15;
    const geom = new THREE.CylinderGeometry(stockRadius, stockRadius, stockHeight, 64, 1);
    const transf = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 0, stockHeight / 2),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
        new THREE.Vector3(1, 1, 1));
    geom.applyMatrix4(transf);
    return geom;
};


// [in] VoxelGrid
// [in] label optional string to display on the voxel grid
// returns: THREE.Object3D
const createVgVis = (vg, label = "") => {
    const cubeGeom = new THREE.BoxGeometry(vg.res * 0.9, vg.res * 0.9, vg.res * 0.9);

    //const num = vg.count();
    const meshFull = new THREE.InstancedMesh(cubeGeom, new THREE.MeshNormalMaterial(), vg.countEq(255));
    const meshPartial = new THREE.InstancedMesh(cubeGeom, new THREE.MeshNormalMaterial({transparent: true, opacity: 0.25}), vg.countEq(128));
    
    //const mesh = new THREE.InstancedMesh(cubeGeom, new THREE.MeshNormalMaterial(), num);
    let instanceIxFull = 0;
    let instanceIxPartial = 0;
    for (let iz = 0; iz < vg.numZ; iz++) {
        for (let iy = 0; iy < vg.numY; iy++) {
            for (let ix = 0; ix < vg.numX; ix++) {
                const v = vg.get(ix, iy, iz);
                if (v === 0) {
                    continue;
                }

                const mtx = new THREE.Matrix4();
                mtx.compose(
                    new THREE.Vector3(ix, iy, iz).addScalar(0.5).multiplyScalar(vg.res),
                    new THREE.Quaternion(),
                    new THREE.Vector3(1, 1, 1).multiplyScalar(v === 255 ? 1.0 : 0.8));

                if (v === 255) {
                    meshFull.setMatrixAt(instanceIxFull, mtx);
                    instanceIxFull++;
                } else {
                    meshPartial.setMatrixAt(instanceIxPartial, mtx);
                    instanceIxPartial++;
                }
            }
        }
    }

    const meshContainer = new THREE.Object3D();
    meshContainer.add(meshFull);
    meshContainer.add(meshPartial);
    meshContainer.position.copy(vg.ofs);

    const axesHelper = new THREE.AxesHelper();
    axesHelper.scale.set(vg.res * vg.numX, vg.res * vg.numY, vg.res * vg.numZ);
    meshFull.add(axesHelper);

    if (label !== "") {
        const textGeom = new TextGeometry(label, {
            font,
            size: 2,
            depth: 0.1,
         });
        const textMesh = new THREE.Mesh(textGeom, new THREE.MeshBasicMaterial({ color: "#222222" }));
        meshContainer.add(textMesh);
    }
    
    return meshContainer;
};



// Visualize tool tip path in machine coordinates.
//
// [in] array of THREE.Vector3, path segments
// [in] highlightSweep number, sweep index to highlight
// returns: THREE.Object3D
const createPathVis = (path, highlightSweep = 2) => {
    if (path.length === 0) {
        return new THREE.Object3D();
    }

    const pathVis = new THREE.Object3D();

    // add remove path vis
    const vs = [];
    const cs = [];
    let prevTipPosW = path[0].tipPosW;
    for (let i = 1; i < path.length; i++) {
        const pt = path[i];
        vs.push(prevTipPosW.x, prevTipPosW.y, prevTipPosW.z);
        vs.push(pt.tipPosW.x, pt.tipPosW.y, pt.tipPosW.z);

        if (pt.sweep === highlightSweep) {
            if (pt.type === "remove-work") {
                // red
                cs.push(0.8, 0, 0);
                cs.push(0.8, 0, 0);
            } else {
                // blue-ish gray
                cs.push(0.5, 0.5, 1);
                cs.push(0.5, 0.5, 1);
            }
        } else {
            if (pt.type === "remove-work") {
                // red-ish faint gray
                cs.push(1, 0.8, 0.8);
                cs.push(1, 0.8, 0.8);
            } else {
                // blue-ish faint gray
                cs.push(0.8, 0.8, 1);
                cs.push(0.8, 0.8, 1);
            }
        }
        prevTipPosW = pt.tipPosW;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vs), 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cs), 3));
    const mat = new THREE.LineBasicMaterial({ vertexColors: true });
    pathVis.add(new THREE.LineSegments(geom, mat));

    // add refresh path vis
    const sphGeom = new THREE.SphereGeometry(0.15);
    const sphRemoveMat = new THREE.MeshBasicMaterial({ color: "red" });
    const sphOtherMat = new THREE.MeshBasicMaterial({ color: "blue" });
    const sphNonHighlight = new THREE.MeshBasicMaterial({ color: "gray" });
    for (let i = 0; i < path.length; i++) {
        const pt = path[i];

        if (pt.sweep !== highlightSweep) {
            if (pt.type !== "remove-work") {
                const sph = new THREE.Mesh(sphGeom, sphNonHighlight);
                sph.position.copy(pt.tipPosW);
                pathVis.add(sph);
            }
        } else {
            if (pt.type === "remove-work") {
                const sph = new THREE.Mesh(sphGeom, sphRemoveMat);
                sph.position.copy(pt.tipPosW);
                pathVis.add(sph);
            } else {
                const sph = new THREE.Mesh(sphGeom, sphOtherMat);
                sph.position.copy(pt.tipPosW);
                pathVis.add(sph);
            }
        }
    }

    return pathVis;
};

// Generates a rotation matrix such that Z+ axis will be formed into "z" vector.
// [in] z THREE.Vector3
// returns: THREE.Matrix4
const createRotationWithZ = (z) => {
    // orthogonalize, with given Z-basis.
    const basisZ = z;
    let basisY;
    const b0 = new THREE.Vector3(1, 0, 0);
    const b1 = new THREE.Vector3(0, 1, 0);
    if (b0.clone().cross(basisZ).length() > 0.3) {
        basisY = b0.clone().cross(basisZ).normalize();
    } else {
        basisY = b1.clone().cross(basisZ).normalize();
    }
    const basisX = basisY.clone().cross(basisZ).normalize();

    return new THREE.Matrix4(
        basisX.x, basisY.x, basisZ.x, 0,
        basisX.y, basisY.y, basisZ.y, 0,
        basisX.z, basisY.z, basisZ.z, 0,
        0, 0, 0, 1,
    );
}


// returns: THREE.Object3D
const generateStock = () => {
    const stock = new THREE.Mesh(
        generateStockGeom(),
        new THREE.MeshLambertMaterial({ color: "blue", wireframe: true, transparent: true, opacity: 0.05 }));
    return stock;
};

// Generate tool geom, origin = tool tip. In Z+ direction, there will be tool base marker.
// returns: THREE.Object3D
const generateTool = (toolLength, toolDiameter) => {
    const toolOrigin = new THREE.Object3D();

    const toolRadius = toolDiameter / 2;
    const baseRadius = 5;

    // note: cylinder geom is Y direction and centered. Need to rotate and shift.

    const tool = new THREE.Mesh(
        new THREE.CylinderGeometry(toolRadius, toolRadius, toolLength, 32, 1),
        new THREE.MeshPhysicalMaterial({ color: 0xf0f0f0, metalness: 0.9, roughness: 0.3, wireframe: true }));
    tool.setRotationFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    tool.position.z = toolLength / 2;

    const toolBase = new THREE.Mesh(
        new THREE.CylinderGeometry(baseRadius, baseRadius, 0, 6, 1),
        new THREE.MeshPhysicalMaterial({ color: 0xe0e0e0, metalness: 0.2, roughness: 0.8, wireframe: true }));
    toolBase.setRotationFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    toolBase.position.z = toolLength;
    toolOrigin.add(toolBase);

    toolOrigin.add(tool);
    return toolOrigin;
};

// planner gets two meshes and generate path as a list of points.
// planner is not pure function. but it's a "module" with UIs and depends on debug stuff.
// thus, planner instance should be kept, even when re-running planner from scratch.
class Planner {
    constructor(updateVis, setVisVisibility) {
        this.updateVis = updateVis;
        this.setVisVisibility = setVisVisibility;

        // machine geometries
        this.toolDiameter = 3;
        this.toolLength = 25;

        this.workOffset = new THREE.Vector3(20, 40, 20); // in machine coords
        this.wireCenter = new THREE.Vector3(30, 15, 30);
        this.stockCenter = new THREE.Vector3(10, 10, 10);

        // tool vis
        this.updateVisTransforms(new THREE.Vector3(-15, -15, 5), new THREE.Vector3(0, 0, 1), this.toolLength);

        // configuration
        this.ewrMax = 0.3;

        // machine-state setup
        this.workCRot = 0;

        this.resMm = 0.25;
        this.showWork = true;
        this.showTarget = false;
        this.targetSurf = null;

        this.numSweeps = 0;
        this.showingSweep = 0;
        this.removedVol = 0;
        this.toolIx = 0;
        this.showSweepVis = false;
        this.showPlanPath = true;
    }

    // [in] gui lilgui instance
    guiHook(gui) {
        gui.add(this, "resMm", [1e-3, 5e-2, 1e-2, 1e-1, 0.25, 0.5, 1]);

        gui.add(this, "initPlan");
        gui.add(this, "genNextSweep");
        gui.add(this, "genNextSweep10");
        gui.add(this, "genAllSweeps");
        gui.add(this, "numSweeps").disable().listen();
        gui.add(this, "removedVol").name("Removed Vol (㎣)").disable().listen();
        gui.add(this, "toolIx").disable().listen();
        gui.add(this, "showTarget")
            .onChange(_ => this.setVisVisibility("targ-vg", this.showTarget))
            .listen();
        gui.add(this, "showWork")
            .onChange(_ => this.setVisVisibility("work-vg", this.showWork))
            .listen();
        gui.add(this, "showSweepVis")
            .onChange(_ => this.setVisVisibility("sweep-vis", this.showSweepVis))
            .listen();
        gui.add(this, "showPlanPath")
            .onChange(_ => this.setVisVisibility("plan-path-vg", this.showPlanPath))
            .listen();
    }

    animateHook() {
        if (this.genSweeps) {
            const res = this.genNextSweep();
            if (!res) {
                this.genSweeps = false; // done
            }
        }
    }


    initPlan() {
        this.numSweeps = 0;
        this.showingSweep = 0;
        this.removedVol = 0;
        this.toolIx = 0;

        this.stockSurf = convGeomToSurf(generateStockGeom());
        const workVg = initVGForPoints(this.stockSurf, this.resMm);
        const targVg = workVg.clone();
        diceSurf(this.stockSurf, workVg);
        diceSurf(this.targetSurf, targVg);

        this.trvg = new TrackingVoxelGrid(workVg.res, workVg.numX, workVg.numY, workVg.numZ, workVg.ofs.clone());
        this.trvg.setFromWorkAndTarget(workVg, targVg);

        this.planPath = [];
        const candidateNormals = [
            new THREE.Vector3(1, 0, 0),
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(-1, 0, 0),
            new THREE.Vector3(0, -1, 0),
            new THREE.Vector3(0, 0, 1),
        ];
        this.planner = {
            normalIndex: 0,
            normals: candidateNormals,
            offsets: candidateNormals.map(n => this.trvg.queryWorkOffset(n)),
        };

        this.updateVis("work-vg", [createVgVis(this.trvg.extractWork())], this.showWork);
        this.updateVis("targ-vg", [createVgVis(this.trvg.extractTarget())], this.showTarget);
        this.updateVis("plan-path-vg", [createPathVis(this.planPath)], this.showPlanPath);
    }

    genNextSweep10() {
        for (let i = 0; i < 10; i++) {
            const committed = this.genNextSweep();
            if (!committed) {
                break;
            }
        }
    }

    genAllSweeps() {
        this.genSweeps = true;
    }

    // Pre/post-condition of sweep:
    // * tool is not touching work nor grinder
    // * de-energized
    // returns: true if sweep is committed, false if not
    genNextSweep() {
        if (this.trvg === undefined) {
            this.initPlan();
        }

        const diffVg = this.trvg.extractWork();
        if (diffVg.count() === 0) {
            console.log("done!");
            return false;
        }

        // Sweep hyperparams
        const feedDepth = 1; // TODO: reduce later. currently too big for easy debug.

        const sweepVises = [];

        // Generate "planar sweep", directly below given plane.
        //
        // [in] normal THREE.Vector3, work coords. = tip normal
        // [in] offset number. offset * normal forms the plane.
        //
        // returns: {
        //   path: array<Vector3>,
        //   deltaWork: VG,
        //   toolLength: number,
        //   toolIx: number,
        //   vis: {target: VG, blocked: VG}
        // } | null (if impossible)
        const genPlanarSweep = (normal, offset) => {
            const rot = createRotationWithZ(normal);
            const feedDir = new THREE.Vector3(1, 0, 0).transformDirection(rot);
            const rowDir = new THREE.Vector3(0, 1, 0).transformDirection(rot);

            const halfDiagVec = new THREE.Vector3(this.trvg.numX, this.trvg.numY, this.trvg.numZ).multiplyScalar(this.trvg.res * 0.5);
            const trvgCenter = this.trvg.ofs.clone().add(halfDiagVec);
            const trvgRadius = halfDiagVec.length(); // TODO: proper bounds

            // rows : [row]
            // row : [segment]
            // segment : {
            //   accessOk: bool, // can enter this segment from left.
            //   workOk: bool, // work is available in this segment, and is not blocked.
            // }
            const rows = [];

            const feedWidth = this.toolDiameter / 2;
            const segmentLength = this.toolDiameter / 2;
            const numRows = Math.ceil(trvgRadius * 2 / feedWidth);
            const numSegs = Math.ceil(trvgRadius * 2 / segmentLength);
            const scanOrigin = 
                trvgCenter.clone().projectOnPlane(normal)
                    .add(normal.clone().multiplyScalar(offset))
                    .add(feedDir.clone().multiplyScalar(-trvgRadius))
                    .add(rowDir.clone().multiplyScalar(-trvgRadius));
            
            sweepVises.length = 0;
            for (let ixRow = 0; ixRow < numRows; ixRow++) {
                const row = [];
                for (let ixSeg = 0; ixSeg < numSegs; ixSeg++) {
                    const segBegin = scanOrigin.clone()
                        .add(rowDir.clone().multiplyScalar(feedWidth * ixRow))
                        .add(feedDir.clone().multiplyScalar(segmentLength * ixSeg));
                    const segEnd = segBegin.clone().add(feedDir.clone().multiplyScalar(segmentLength));

                    const segBeginBot = segBegin.clone().sub(normal.clone().multiplyScalar(feedDepth));
                    const segEndBot = segEnd.clone().sub(normal.clone().multiplyScalar(feedDepth));
                    
                    const accessOk = !this.trvg.queryBlockedCylinder(segBeginBot, normal, this.toolDiameter / 2);
                    
                    // notBlocked is required when there's work-remaining overhang; technically the tool can cut the overhang too,
                    // but should be avoided to localize tool wear.
                    // const notBlocked = !this.trvg.queryBlockedELH(segBegin, segEnd, normal, this.toolDiameter / 2, outerRadius);
                    const notBlocked = true;
                    const collateralRange = 100;
                    const okToCut = this.trvg.queryOkToCutELH(segBeginBot, segEndBot, normal, this.toolDiameter / 2, feedDepth, collateralRange);
                    
                    const workOk = notBlocked && okToCut;

                    /*
                    const col = new THREE.Color().setRGB(0, notBlocked ? .5 : 0, okToCut ? .5 : 0);
                    let label = "";
                    label += `${ixRow},${ixSeg}:`;
                    label += accessOk ? "A" : "";
                    label += notBlocked ? "O" : "";
                    if (label.length > 0) {
                        sweepVises.push(createTextVis(segBeginBot, label, 0.25, col));
                    }
                    */

                    row.push({ accessOk, workOk, segBegin, segEnd, segBeginBot, segEndBot });
                }
                rows.push(row);
            }
            // console.log("sweep-rows", rows);

            // in planar sweep, tool is eroded only from the side.
            const maxWidthLoss = feedWidth * 0.1; // *0.5 is fine for EWR. but with coarse grid, needs to be smaller to not leave gaps between rows.
            const tipRefreshDist = Math.PI * (Math.pow(this.toolDiameter / 2, 2) - Math.pow(this.toolDiameter / 2 - maxWidthLoss, 2)) / this.ewrMax / feedWidth;
            
            // generate zig-zag
            //let currIx = minPt.x;
            //let currIy = minPt.y;
            let distSinceRefresh = 0;
            let toolLength = this.toolLength;
            let toolIx = this.toolIx;
            let prevPtTipPos = null;
            const sweepPath = [];

            const withAxisValue = (pt) => {
                const isPosW = pt.tipPosW !== undefined;
                const ikResult = this.#solveIk(isPosW ? pt.tipPosW : pt.tipPosM, pt.tipNormalW, toolLength, isPosW);
                return {
                    ...pt,
                    tipPosM: ikResult.tipPosM,
                    tipPosW: ikResult.tipPosW,
                    axisValues: ikResult.vals,
                };
            };

            const minSweepRemoveGeoms = [];
            const maxSweepRemoveGeoms = [];
            const pushRemoveMovement = (pathPt) => {
                if (prevPtTipPos === null) {
                    throw "remove path needs prevPtTipPos to be set by pushNonRemoveMovement";
                }
                
                minSweepRemoveGeoms.push({
                    // extruded long hole
                    // hole spans from two centers; p and q, with radius r.
                    // the long hole is then extended towards n direction infinitely.
                    p: prevPtTipPos,
                    q: pathPt.tipPosW,
                    n: pathPt.tipNormalW,
                    r: this.toolDiameter / 2 - maxWidthLoss,
                });
                maxSweepRemoveGeoms.push({
                    // extruded long hole
                    // hole spans from two centers; p and q, with radius r.
                    // the long hole is then extended towards n direction infinitely.
                    p: prevPtTipPos,
                    q: pathPt.tipPosW,
                    n: pathPt.tipNormalW,
                    r: this.toolDiameter / 2,
                });
                sweepPath.push(withAxisValue(pathPt));
                prevPtTipPos = pathPt.tipPosW;
            };

            const pushNonRemoveMovement = (pathPt) => {
                sweepPath.push(withAxisValue(pathPt));
                prevPtTipPos = pathPt.tipPosW;
            };

            const evacuateOffset = normal.clone().multiplyScalar(3);

            for (let ixRow = 0; ixRow < rows.length; ixRow++) {
                const row = rows[ixRow];
                let entered = false;
                for (let ixSeg = 0; ixSeg < row.length; ixSeg++) {
                    const seg = row[ixSeg];
                    const pushRemoveThisSeg = () => {
                        pushRemoveMovement({
                            sweep: this.numSweeps,
                            group: `sweep-${this.numSweeps}`,
                            type: "remove-work",
                            tipNormalW: normal,
                            tipPosW: seg.segEndBot,
                            toolRotDelta: 123, // TODO: Fix
                        });
                    };

                    if (!entered) {
                        if (seg.accessOk & seg.workOk) {
                            pushNonRemoveMovement({
                                sweep: this.numSweeps,
                                group: `sweep-${this.numSweeps}`,
                                type: "move-in",
                                tipNormalW: normal,
                                tipPosW: seg.segBegin.clone().add(evacuateOffset),
                            });
                            pushNonRemoveMovement({
                                sweep: this.numSweeps,
                                group: `sweep-${this.numSweeps}`,
                                type: "move-in",
                                tipNormalW: normal,
                                tipPosW: seg.segBeginBot,
                            });
                            pushRemoveThisSeg();
                            entered = true;
                        }
                    } else {
                        if (seg.workOk && ixSeg !== row.length - 1) {
                            pushRemoveThisSeg();
                        } else {
                            pushNonRemoveMovement({
                                sweep: this.numSweeps,
                                group: `sweep-${this.numSweeps}`,
                                type: "move-out",
                                tipNormalW: normal,
                                tipPosW: seg.segBegin.clone().add(evacuateOffset),
                            });
                            entered = false;
                        }
                    }
                }

                if (entered) {
                    throw "Row ended, but path continues; scan range too small";
                }
            }

            if (sweepPath.length === 0) {
                return null;
            }

            return {
                path: sweepPath,
                deltaWork: {max: maxSweepRemoveGeoms, min: minSweepRemoveGeoms},
                toolIx: toolIx,
                toolLength: toolLength,
            };
        };

        // Generate "drill sweep", axis=normal.
        // [in] normal THREE.Vector3, work coords. = tip normal
        // returns: {
        //   path: array<Vector3>,
        //   deltaWork: VG,
        //   toolLength: number,
        //   toolIx: number,
        //   vis: {target: VG, blocked: VG}
        // } | null (if impossible)
        const genDrillSweep = (normal) => {
            const rot = createRotationWithZ(normal);
            const scanDir0 = new THREE.Vector3(1, 0, 0).transformDirection(rot);
            const scanDir1 = new THREE.Vector3(0, 1, 0).transformDirection(rot);

            const halfDiagVec = new THREE.Vector3(this.trvg.numX, this.trvg.numY, this.trvg.numZ).multiplyScalar(this.trvg.res * 0.5);
            const trvgCenter = this.trvg.ofs.clone().add(halfDiagVec);
            const trvgRadius = halfDiagVec.length(); // TODO: proper bounds

            const scanRes = 1;
            const numScan0 = Math.ceil(trvgRadius * 2 / scanRes);
            const numScan1 = Math.ceil(trvgRadius * 2 / scanRes);
            const scanOrigin = trvgCenter.clone().sub(scanDir0.clone().multiplyScalar(trvgRadius)).sub(scanDir1.clone().multiplyScalar(trvgRadius));

            const holeDiameter = this.toolDiameter * 1.1;

            // grid query for drilling
            // if ok, just drill it with helical downwards path.
            const drillHoles = [];
            for (let ixScan0 = 0; ixScan0 < numScan0; ixScan0++) {
                for (let ixScan1 = 0; ixScan1 < numScan1; ixScan1++) {
                    const scanPt = scanOrigin.clone()
                        .add(scanDir0.clone().multiplyScalar(scanRes * ixScan0))
                        .add(scanDir1.clone().multiplyScalar(scanRes * ixScan1));
                    
                    const holeBot = scanPt.clone().sub(normal.clone().multiplyScalar(trvgRadius));
                    const ok = this.trvg.queryOkToCutCylinder(holeBot, normal, holeDiameter / 2);
                    if (ok) {
                        debug.vlogE(createErrorLocVis(holeBot, "red"));
                        drillHoles.push({
                            pos: scanPt
                        });
                    } else {
                        debug.vlogE(createErrorLocVis(holeBot, "blue"));
                    }
                }
            }
            console.log("drillHoles", drillHoles);

            // Generate paths
            let prevPtTipPos = null;
            const sweepPath = [];

            const withAxisValue = (pt) => {
                const isPosW = pt.tipPosW !== undefined;
                const ikResult = this.#solveIk(isPosW ? pt.tipPosW : pt.tipPosM, pt.tipNormalW, toolLength, isPosW);
                return {
                    ...pt,
                    tipPosM: ikResult.tipPosM,
                    tipPosW: ikResult.tipPosW,
                    axisValues: ikResult.vals,
                };
            };

            const minSweepRemoveGeoms = [];
            const maxSweepRemoveGeoms = [];
            const pushRemoveMovement = (pathPt) => {
                if (prevPtTipPos === null) {
                    throw "remove path needs prevPtTipPos to be set by pushNonRemoveMovement";
                }
                
                minSweepRemoveGeoms.push({
                    // extruded long hole
                    // hole spans from two centers; p and q, with radius r.
                    // the long hole is then extended towards n direction infinitely.
                    p: prevPtTipPos,
                    q: pathPt.tipPosW,
                    n: pathPt.tipNormalW,
                    r: this.toolDiameter / 2 - maxWidthLoss,
                });
                maxSweepRemoveGeoms.push({
                    // extruded long hole
                    // hole spans from two centers; p and q, with radius r.
                    // the long hole is then extended towards n direction infinitely.
                    p: prevPtTipPos,
                    q: pathPt.tipPosW,
                    n: pathPt.tipNormalW,
                    r: this.toolDiameter / 2,
                });
                sweepPath.push(withAxisValue(pathPt));
                prevPtTipPos = pathPt.tipPosW;
            };

            const pushNonRemoveMovement = (pathPt) => {
                sweepPath.push(withAxisValue(pathPt));
                prevPtTipPos = pathPt.tipPosW;
            };

            const evacuateOffset = normal.clone().multiplyScalar(3);
            
            return null;
        };

        let sweep = null;
        for (let i = 0; i < this.planner.normals.length; i++) {
            sweep = genDrillSweep(this.planner.normals[this.planner.normalIndex]);
            this.updateVis("sweep-vis", sweepVises, this.showSweepVis);
            if (sweep) {
                console.log(`trying to commit sweep ${this.numSweeps}`, sweep);

                const volRemoved = this.trvg.commitRemoval(sweep.deltaWork.min, sweep.deltaWork.max);
                if (volRemoved === 0) {
                    console.log("rejected, because work not removed");
                    continue;
                } else {
                    // commit success
                    this.removedVol += volRemoved;
                    this.planPath.push(...sweep.path);
                    this.toolIx = sweep.toolIx;
                    this.toolLength = sweep.toolLength;
                    this.numSweeps++;
                    this.showingSweep++;
                    break;
                }
            }
            this.planner.normalIndex = (this.planner.normalIndex + 1) % this.planner.normals.length;
        }
        for (let i = 0; i < this.planner.normals.length; i++) {
            if (sweep) {
                break;
            }

            sweep = genPlanarSweep(this.planner.normals[this.planner.normalIndex], this.planner.offsets[this.planner.normalIndex]);
            this.planner.offsets[this.planner.normalIndex] -= feedDepth;

            this.updateVis("sweep-vis", sweepVises, this.showSweepVis);
            if (sweep) {
                console.log(`trying to commit sweep ${this.numSweeps}`, sweep);

                const volRemoved = this.trvg.commitRemoval(sweep.deltaWork.min, sweep.deltaWork.max);
                if (volRemoved === 0) {
                    console.log("rejected, because work not removed");
                    continue;
                } else {
                    // commit success
                    this.removedVol += volRemoved;
                    this.planPath.push(...sweep.path);
                    this.toolIx = sweep.toolIx;
                    this.toolLength = sweep.toolLength;
                    this.numSweeps++;
                    this.showingSweep++;
                    break;
                }
            }
            this.planner.normalIndex = (this.planner.normalIndex + 1) % this.planner.normals.length;
        }

        if (sweep === null) {
            console.log("possible sweep exhausted");
            return false;
        }

        this.updateVis("plan-path-vg", [createPathVis(this.planPath)], this.showPlanPath, false);
        this.updateVis("work-vg", [createVgVis(this.trvg.extractWork(), "work-vg")], this.showWork);

        const lastPt = this.planPath[this.planPath.length - 1];
        this.updateVisTransforms(lastPt.tipPosW, lastPt.tipNormalW, this.toolLength);

        return true;
    }

    // Computes tool base & work table pos from tip target.
    //
    // [in] tipPos tip position in work coordinates
    // [in] tipNormalW tip normal in machine coordinates (+ is pointing towards base = work surface normal)
    // [in] isPosW true: tipPos is in work coordinates, false: tipPos is in machine coordinates
    // [out] {vals: {x, y, z, b, c} machine instructions for moving work table & tool base, tipPosM: THREE.Vector3 tip position in machine coordinates}
    #solveIk(tipPos, tipNormalW, toolLength, isPosW) {
        // Order of determination ("IK")
        // 1. Determine B,C axis
        // 2. Determine X,Y,Z axis
        // TODO: A-axis
        // (X,Y,Z) -> B * toolLen = tipPt

        const EPS_ANGLE = 1e-3 / 180 * Math.PI; // 1/1000 degree

        const n = tipNormalW.clone();
        if (n.z < 0) {
            console.error("Impossible tool normal; path will be invalid", n);
        }

        n.z = 0;
        const bAngle = Math.asin(n.length());
        let cAngle = 0;
        if (bAngle < EPS_ANGLE) {
            // Pure Z+. Prefer neutral work rot.
            cAngle = 0;
        } else {
            cAngle = -Math.atan2(n.y, n.x);
        }
        
        const tipPosM = tipPos.clone();
        const tipPosW = tipPos.clone();
        if (isPosW) {
            tipPosM.applyAxisAngle(new THREE.Vector3(0, 0, 1), cAngle);
            tipPosM.add(this.workOffset);
        } else {
            tipPosW.sub(this.workOffset);
            tipPosW.applyAxisAngle(new THREE.Vector3(0, 0, 1), -cAngle);
        }

        const offsetBaseToTip = new THREE.Vector3(-Math.sin(bAngle), 0, -Math.cos(bAngle)).multiplyScalar(toolLength);
        const tipBasePosM = tipPosM.clone().sub(offsetBaseToTip);

        return {
            vals: {
                x: tipBasePosM.x,
                y: tipBasePosM.y,
                z: tipBasePosM.z,
                b: bAngle,
                c: cAngle,
            },
            tipPosM: tipPosM,
            tipPosW: tipPosW,
        };
    }

    updateVisTransforms(tipPos, tipNormal, toolLength) {
        const tool = generateTool(toolLength, this.toolDiameter);
        this.updateVis("tool", [tool], true);

        tool.position.copy(tipPos);
        tool.setRotationFromMatrix(createRotationWithZ(tipNormal));
    }
}



////////////////////////////////////////////////////////////////////////////////
// 3D view (Module + basis)


// Apply transformation to AABB, and return the transformed AABB.
// [in] min, max THREE.Vector3 in coordinates A.
// [in] mtx THREE.Matrix4 transforms (A -> B)
// returns: {min: THREE.Vector3, max: THREE.Vector3} in coordinates B.
const transformAABB = (min, max, mtx) => {
    const minB = new THREE.Vector3(1e100, 1e100, 1e100);
    const maxB = new THREE.Vector3(-1e100, -1e100, -1e100);
    for (let i = 0; i < 8; i++) {
        const cubeVertex = new THREE.Vector3(
            (i & 1) ? min.x : max.x,
            (i & 2) ? min.y : max.y,
            (i & 4) ? min.z : max.z,
        ).applyMatrix4(mtx);
        minB.min(cubeVertex);
        maxB.max(cubeVertex);
    }
    return { min: minB, max: maxB };
};


// Provides basic UI framework, 3D scene, and mesh/gcode I/O UI.
// Scene is in mm unit. Right-handed, Z+ up. Work-coordinates.
class View3D {
    constructor() {
        this.init();

        this.models = {
            GT2_PULLEY: "GT2_pulley",
            HELICAL_GEAR: "helical_gear",
            HELICAL_GEAR_STANDING: "helical_gear_standing",
            DICE_TOWER: "dice_tower",
            BENCHY: "benchy_25p",
            BOLT_M3: "M3x10",
        };

        // work-coords
        this.visGroups = {};
        const gridHelperBottom = new THREE.GridHelper(40, 4);
        gridHelperBottom.rotateX(Math.PI / 2);
        this.scene.add(gridHelperBottom);

        const stock = generateStock();
        this.objStock = stock;
        this.scene.add(stock);
        this.model = this.models.GT2_PULLEY;
        this.showStockMesh = true;
        this.showTargetMesh = true;

        this.vlogErrors = [];
        this.lastNumVlogErrors = 0;
        
        // Visually log errors.
        // [in] obj: THREE.Object3D
        debug.vlogE = (obj) => {
            this.vlogErrors.push(obj);
            this.scene.add(obj);
        };

        this.modPlanner = new Planner((group, vs, visible = true) => this.updateVis(group, vs, visible), (group, visible = true) => this.setVisVisibility(group, visible));
        this.initGui();
    }

    initGui() {
        const gui = new GUI();
        gui.add(this, 'model', this.models).onChange((model) => {
            this.updateVis("targ-vg", []);
            this.updateVis("work-vg", []);
            this.updateVis("misc", []);
            this.loadStl(model);
        });
        gui.add(this, "showStockMesh").onChange(v => {
            this.objStock.visible = v;
        }).listen();
        gui.add(this, "showTargetMesh").onChange(v => {
            this.setVisVisibility("target", v);
        }).listen();

        this.modPlanner.guiHook(gui);
        
        gui.add(this, "copyGcode");
        gui.add(this, "sendGcodeToSim");
    
        this.loadStl(this.model);
    }

    init() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        const aspect = width / height;
        this.camera = new THREE.OrthographicCamera(-25 * aspect, 25 * aspect, 25, -25, -150, 150);
        this.camera.position.x = 15;
        this.camera.position.y = 40;
        this.camera.position.z = 20;
        this.camera.up.set(1, 0, 0);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(width, height);
        this.renderer.setAnimationLoop(() => this.animate());
        this.container = document.getElementById('container');
        this.container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xffffff);

        const light = new THREE.AmbientLight(0x404040); // soft white light
        this.scene.add(light);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(0, 0, 1);
        this.scene.add(directionalLight);

        const hemiLight = new THREE.HemisphereLight(0xffffbb, 0x080820, 1);
        this.scene.add(hemiLight);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);

        this.stats = new Stats();
        container.appendChild(this.stats.dom);

        const guiStatsEl = document.createElement('div');
        guiStatsEl.classList.add('gui-stats');

        window.addEventListener('resize', () => this.onWindowResize());
        Object.assign(window, { scene: this.scene });
    }

    loadStl(fname) {
        const loader = new STLLoader();
        loader.load(
            `models/${fname}.stl`,
            (geometry) => {
                // To avoid parts going out of work by numerical error, slightly offset the part geometry.
                translateGeom(geometry, new THREE.Vector3(0, 0, 0.5));
                this.targetSurf = convGeomToSurf(geometry);
                this.modPlanner.targetSurf = this.targetSurf;

                const material = new THREE.MeshPhysicalMaterial({
                    color: 0xb2ffc8,
                    metalness: 0.1,
                    roughness: 0.8,
                    transparent: true,
                    opacity: 0.8,
                });

                const mesh = new THREE.Mesh(geometry, material)
                this.updateVis("target", [mesh]);
            },
            (xhr) => {
                console.log((xhr.loaded / xhr.total) * 100 + '% loaded')
            },
            (error) => {
                console.log(error);
            }
        );
    }

    copyGcode() {
        const prog = this.generateGcode();
        navigator.clipboard.writeText(prog);
    }

    sendGcodeToSim() {
        const prog = this.generateGcode();
        new BroadcastChannel("gcode").postMessage(prog);
    }

    generateGcode() {
        const planPath = this.modPlanner.planPath;

        let prevSweep = null;
        let prevType = null;
        let prevX = null;
        let prevY = null;
        let prevZ = null;
        let prevB = null;
        let prevC = null;

        const lines = [];

        lines.push(`; init`);
        lines.push(`G28`);
        lines.push(`M100`);
        lines.push(`M102`);

        for (let i = 0; i < planPath.length; i++) {
            const pt = planPath[i];
            if (prevSweep !== pt.sweep) {
                lines.push(`; sweep-${pt.sweep}`);
                prevSweep = pt.sweep;
            }

            let gcode = [];
            if (pt.type === "remove-work") {
                if (prevType !== pt.type) {
                    lines.push(`M3 WV100`);
                }
                gcode.push("G1");
            } else if (pt.type === "remove-tool") {
                if (prevType !== pt.type) {
                    lines.push(`M4 GV-100`);
                }
                gcode.push("G1");
            } else if (pt.type === "move-out" || pt.type === "move-in") {
                if (prevType !== pt.type) {
                    lines.push(`M5`);
                }
                gcode.push("G0");
            } else {
                console.error("unknown path segment type", pt.type);
            }
            prevType = pt.type;

            const vals = pt.axisValues;
            if (prevX !== vals.x) {
                gcode.push(`X${vals.x.toFixed(3)}`);
                prevX = vals.x;
            }
            if (prevY !== vals.y) {
                gcode.push(`Y${vals.y.toFixed(3)}`);
                prevY = vals.y;
            }
            if (prevZ !== vals.z) {
                gcode.push(`Z${vals.z.toFixed(3)}`);
                prevZ = vals.z;
            }
            if (prevB !== vals.b) {
                gcode.push(`B${(vals.b * 180 / Math.PI).toFixed(3)}`);
                prevB = vals.b;
            }
            if (prevC !== vals.c) {
                gcode.push(`C${(vals.c * 180 / Math.PI).toFixed(3)}`);
                prevC = vals.c;
            }
            if (pt.toolRotDelta !== undefined) {
                gcode.push(`D${(pt.toolRotDelta * 180 / Math.PI).toFixed(2)}`);
            }
            if (pt.grindDelta !== undefined) {
                gcode.push(`GW${pt.grindDelta.toFixed(1)}`);
            }

            lines.push(gcode.join(" "));
        }

        lines.push(`; end`);
        lines.push(`M103`);

        lines.push("");
        return lines.join("\n");
    }

    updateVis(group, vs, visible = true) {
        if (this.visGroups[group]) {
            this.visGroups[group].forEach(v => this.scene.remove(v));
        }
        vs.forEach(v => {
            this.scene.add(v);
            v.visible = visible;
        });
        this.visGroups[group] = vs;
    }

    setVisVisibility(group, visible) {
        if (this.visGroups[group]) {
            this.visGroups[group].forEach(v => v.visible = visible);
        }
    }

    onWindowResize() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        this.renderer.setSize(width, height);
    }

    animate() {
        this.modPlanner.animateHook();

        if (this.vlogErrors.length > this.lastNumVlogErrors) {
            console.warn(`${this.vlogErrors.length - this.lastNumVlogErrors} new errors`);
            this.lastNumVlogErrors = this.vlogErrors.length;
        }

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
        this.stats.update();
    }
}

const loadFont = async () => {
    return new Promise((resolve) => {
        fontLoader.load("./Source Sans 3_Regular.json", (f) => {
            font = f;
            resolve();
        });
    });
};

(async () => {
    await loadFont();
    const view = new View3D();
})();
