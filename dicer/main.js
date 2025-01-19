import * as THREE from 'three';
import { Vector3 } from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { N8AOPass } from './N8AO.js';
import { VoxelGrid } from './voxel.js';
import { diceSurf } from './mesh.js';
import { createSdf, createSdfElh, createSdfCylinder, createELHShape, createCylinderShape, anyPointInsideIs, everyPointInsideIs } from './voxel.js';

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

    // Designate work below specified z to be protected. Primarily used to mark stock that should be kept for next session.
    // [in] z: Z+ in work coords.
    setProtectedWorkBelowZ(z) {
        this.protectedWorkBelowZ = z;
        for (let iz = 0; iz < this.numZ; iz++) {
            for (let iy = 0; iy < this.numY; iy++) {
                for (let ix = 0; ix < this.numX; ix++) {
                    const p = this.centerOf(ix, iy, iz);
                    if (p.z < z) {
                        if (this.get(ix, iy, iz) === C_EMPTY_REMAINING) {
                            this.set(ix, iy, iz, C_FULL_DONE);
                        }
                    }
                }
            }
        }
    }

    // Scaffold for refactoring.
    // [in] excludeProtectedWork: if true, exclude protected work.
    // returns: VoxelGrid (0: empty, 128: partial done, 255: full)
    extractWork(excludeProtectedWork = false) {
        const res = new VoxelGrid(this.res, this.numX, this.numY, this.numZ, this.ofs);
        for (let iz = 0; iz < this.numZ; iz++) {
            for (let iy = 0; iy < this.numY; iy++) {
                for (let ix = 0; ix < this.numX; ix++) {
                    if (excludeProtectedWork && this.protectedWorkBelowZ !== undefined && this.centerOf(ix, iy, iz).z < this.protectedWorkBelowZ) {
                        res.set(ix, iy, iz, 0);
                        continue;
                    }

                    const s = this.get(ix, iy, iz);
                    if (s === C_FULL_DONE || s === C_EMPTY_REMAINING || s === C_PARTIAL_REMAINING) {
                        res.set(ix, iy, iz, 255);
                    } else if (s === C_PARTIAL_DONE) {
                        res.set(ix, iy, iz, 128);
                    } else {
                        res.set(ix, iy, iz, 0);
                    }
                }
            }
        }
        return res;
    }

    // Extract work volume as voxels. Each cell will contain deviation from target shape.
    // positive value indicates deviation. 0 for perfect finish or inside. -1 for empty regions.
    //
    // [in] excludeProtectedWork: if true, exclude protected work. (treat them as empty)
    // returns: VoxelGrid(f32)
    extractWorkWithDeviation() {
        // Jump Flood
        const dist = new VoxelGrid(this.res, this.numX, this.numY, this.numZ, this.ofs, "f32"); // -1 means invalid data.
        const seedPosX = new VoxelGrid(this.res, this.numX, this.numY, this.numZ, this.ofs, "f32");
        const seedPosY = new VoxelGrid(this.res, this.numX, this.numY, this.numZ, this.ofs, "f32");
        const seedPosZ = new VoxelGrid(this.res, this.numX, this.numY, this.numZ, this.ofs, "f32");

        // Initialize with target data.
        dist.fill(-1);
        for (let iz = 0; iz < this.numZ; iz++) {
            for (let iy = 0; iy < this.numY; iy++) {
                for (let ix = 0; ix < this.numX; ix++) {
                    if (this.getT(ix, iy, iz) !== TG_EMPTY) {
                        const pos = this.centerOf(ix, iy, iz);
                        dist.set(ix, iy, iz, 0);
                        seedPosX.set(ix, iy, iz, pos.x);
                        seedPosY.set(ix, iy, iz, pos.y);
                        seedPosZ.set(ix, iy, iz, pos.z);
                    }
                }
            }
        }

        const numPass = Math.ceil(Math.log2(Math.max(this.numX, this.numY, this.numZ)));
        const neighborOffsets = [
            [-1, 0, 0],
            [1, 0, 0],
            [0, -1, 0],
            [0, 1, 0],
            [0, 0, -1],
            [0, 0, 1],
        ]; // maybe better to use 26-neighbor
        for (let pass = 0; pass < numPass; pass++) {
            const step = Math.pow(2, numPass - pass - 1);
            for (let iz = 0; iz < this.numZ; iz++) {
                for (let iy = 0; iy < this.numY; iy++) {
                    for (let ix = 0; ix < this.numX; ix++) {
                        const pos = this.centerOf(ix, iy, iz);
                        if (dist.get(ix, iy, iz) === 0) {
                            continue; // no possibility of change
                        }

                        for (const neighborOffset of neighborOffsets) {
                            const nx = ix + neighborOffset[0] * step;
                            const ny = iy + neighborOffset[1] * step;
                            const nz = iz + neighborOffset[2] * step;
                            if (nx < 0 || nx >= this.numX || ny < 0 || ny >= this.numY || nz < 0 || nz >= this.numZ) {
                                continue;
                            }
                            if (dist.get(nx, ny, nz) < 0) {
                                continue; // neibor is invalid
                            }
                            const nSeedPos = new THREE.Vector3(seedPosX.get(nx, ny, nz), seedPosY.get(nx, ny, nz), seedPosZ.get(nx, ny, nz));
                            const dNew = nSeedPos.distanceTo(pos);
                            if (dist.get(ix, iy, iz) < 0 || dNew < dist.get(ix, iy, iz)) {
                                dist.set(ix, iy, iz, dNew);
                                seedPosX.set(ix, iy, iz, nSeedPos.x);
                                seedPosY.set(ix, iy, iz, nSeedPos.y);
                                seedPosZ.set(ix, iy, iz, nSeedPos.z);
                            }
                        }
                    }
                }
            }
        }

        // Convert JF data to work data.
        const vxDiag = this.res * Math.sqrt(3);
        for (let iz = 0; iz < this.numZ; iz++) {
            for (let iy = 0; iy < this.numY; iy++) {
                for (let ix = 0; ix < this.numX; ix++) {
                    const d = dist.get(ix, iy, iz);
                    const s = this.get(ix, iy, iz);
                    if (d < 0) {
                        throw "Jump Flood impl error; failed to cover entire grid";
                    }

                    if (s === C_EMPTY_DONE) {
                        dist.set(ix, iy, iz, -1); // empty
                    } else if (d === 0) {
                        dist.set(ix, iy, iz, 0); // inside
                    } else {
                        // trueD <= 0.5 vxDiag (partial vertex - partial center) + d (partial center - cell center) + 0.5 vxDiag (cell center - cell vertex)
                        // because of triangle inequality.
                        dist.set(ix, iy, iz, d + vxDiag);
                    }
                }
            }
        }
        return dist;
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
    // [in] minShapes: array of shapes, treated as union of all shapes
    // [in] maxShapes: array of shapes, treated as union of all shapes
    // [in] ignoreOvercutErrors: if true, ignore overcut errors. Hack to get final cut done.
    // returns: volume of neewly removed work.
    commitRemoval(minShapes, maxShapes, ignoreOvercutErrors = false) {
        const minVg = new VoxelGrid(this.res, this.numX, this.numY, this.numZ, this.ofs);
        const maxVg = new VoxelGrid(this.res, this.numX, this.numY, this.numZ, this.ofs);
        minShapes.forEach(shape => {
            minVg.fillShape(shape, 255, ignoreOvercutErrors ? "outside" : "inside"); // hack to get "clean-looking" work after final cut.
        });
        maxShapes.forEach(shape => {
            maxVg.fillShape(shape, 255, "outside");
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

                    // Check overcut.
                    if (!ignoreOvercutErrors && isInMax && isTargetNotEmpty) {
                        // this voxel can be potentially uncertainly removed.
                        debug.vlogE(createErrorLocVis(this.centerOf(x, y, z), "violet"));
                        numDamages++;
                    }
                    
                    // Commit.
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

    // Returns true if given shape is blocked by material, conservatively.
    // Conservative: voxels with potential overlaps will be considered for block-detection.
    // [in] shape: shape
    // returns: true if blocked, false otherwise
    queryBlocked(shape) {
        const sdf = createSdf(shape);
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
    // [in] val: voxel value. One of C_FULL_DONE, C_EMPTY_DONE, C_EMPTY_REMAINING, C_PARTIAL_DONE, C_PARTIAL_REMAINING.
    set(ix, iy, iz, val) {
        const i = ix + iy * this.numX + iz * this.numX * this.numY;
        switch (val) {
            case C_FULL_DONE:
                this.dataT[i] = TG_FULL;
                this.dataW[i] = W_DONE;
                break;
            case C_EMPTY_DONE:
                this.dataT[i] = TG_EMPTY;
                this.dataW[i] = W_DONE;
                break;
            case C_EMPTY_REMAINING:
                this.dataT[i] = TG_EMPTY;
                this.dataW[i] = W_REMAINING;
                break;
            case C_PARTIAL_DONE:
                this.dataT[i] = TG_PARTIAL;
                this.dataW[i] = W_DONE;
                break;
            case C_PARTIAL_REMAINING:
                this.dataT[i] = TG_PARTIAL;
                this.dataW[i] = W_REMAINING;
                break;
        }
    }

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
    const MARGIN_MM = resMm; // want to keep boundary one voxel clear to avoid any mishaps. resMm should be enough.
    const { min, max } = computeAABB(pts);
    const center = min.clone().add(max).divideScalar(2);
    
    min.subScalar(MARGIN_MM);
    max.addScalar(MARGIN_MM);

    const numV = max.clone().sub(min).divideScalar(resMm).ceil();
    const gridMin = center.clone().sub(numV.clone().multiplyScalar(resMm / 2));
    return new VoxelGrid(resMm, numV.x, numV.y, numV.z, gridMin);
};

// Apply translation to geometry in-place.
// [in] geom THREE.BufferGeometry
// [in] trans THREE.Vector3
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


// Generate stock cylinder geometry, spanning Z [0, stockHeight].
// [in] stockRadius: number, radius of the stock
// [in] stockHeight: number, height of the stock
// returns: THREE.BufferGeometry
const generateStockGeom = (stockRadius = 7.5, stockHeight = 15) => {
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
// [in] mode "occupancy" | "deviation". "occupancy" treats 255:full, 128:partial, 0:empty. "deviation" is >=0 as deviation and -1 as empty.
// returns: THREE.Object3D
const createVgVis = (vg, label = "", mode="occupancy") => {
    const cubeSize = vg.res * 1.0;
    const cubeGeom = new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize);

    const meshContainer = new THREE.Object3D();
    meshContainer.position.copy(vg.ofs);
    const axesHelper = new THREE.AxesHelper();
    axesHelper.scale.set(vg.res * vg.numX, vg.res * vg.numY, vg.res * vg.numZ);

    if (mode === "occupancy") {
        if (vg.type !== "u8") {
            throw `Invalid vg type for occupancy: ${vg.type}`;
        }

        const meshFull = new THREE.InstancedMesh(cubeGeom, new THREE.MeshLambertMaterial(), vg.countEq(255));
        const meshPartial = new THREE.InstancedMesh(cubeGeom, new THREE.MeshNormalMaterial({transparent: true, opacity: 0.25}), vg.countEq(128));
        
        let instanceIxFull = 0;
        let instanceIxPartial = 0;
        for (let iz = 0; iz < vg.numZ; iz++) {
            for (let iy = 0; iy < vg.numY; iy++) {
                for (let ix = 0; ix < vg.numX; ix++) {
                    const v = vg.get(ix, iy, iz);
                    if (v === 0) {
                        continue;
                    }

                    // whatever different color gradient
                    meshFull.setColorAt(instanceIxFull, new THREE.Color(ix * 0.01 + 0.5, iy * 0.01 + 0.5, iz * 0.01 + 0.5));

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

        meshContainer.add(meshFull);
        meshContainer.add(meshPartial);
        meshFull.add(axesHelper);
    } else if (mode === "deviation") {
        if (vg.type !== "f32") {
            throw `Invalid vg type for deviation: ${vg.type}`;
        }

        const mesh = new THREE.InstancedMesh(cubeGeom, new THREE.MeshLambertMaterial(), vg.numX * vg.numY * vg.numZ - vg.countLessThan(0));

        let instanceIx = 0;
        const maxDev = 3;
        for (let iz = 0; iz < vg.numZ; iz++) {
            for (let iy = 0; iy < vg.numY; iy++) {
                for (let ix = 0; ix < vg.numX; ix++) {
                    const v = vg.get(ix, iy, iz);
                    if (v < 0) {
                        continue;
                    }

                    // apply deviation color, from blue(0) to red(maxDev).
                    const t = Math.min(1, v / maxDev);
                    mesh.setColorAt(instanceIx, new THREE.Color(0.2 + t * 0.8, 0.2, 0.2 + (1 - t) * 0.8));

                    const mtx = new THREE.Matrix4();
                    mtx.compose(
                        new THREE.Vector3(ix, iy, iz).addScalar(0.5).multiplyScalar(vg.res),
                        new THREE.Quaternion(),
                        new THREE.Vector3(1, 1, 1));
                    mesh.setMatrixAt(instanceIx, mtx);
                    instanceIx++;
                }
            }
        }

        meshContainer.add(mesh);
        mesh.add(axesHelper);
    } else {
        throw `Invalid mode: ${mode}`;
    }

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

// Generate stock visualization.
// [in] stockRadius: number, radius of the stock
// [in] stockHeight: number, height of the stock
// [in] baseZ: number, Z+ in machine coords where work coords Z=0 (bottom of the targer surface).
// returns: THREE.Object3D
const generateStock = (stockRadius = 7.5, stockHeight = 15, baseZ = 0) => {
    const stock = new THREE.Mesh(
        generateStockGeom(stockRadius, stockHeight),
        new THREE.MeshLambertMaterial({ color: "blue", wireframe: true, transparent: true, opacity: 0.05 }));
    stock.position.z = -baseZ;
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
        this.stockDiameter = 15;
        this.workCRot = 0;

        this.resMm = 0.25;
        this.stockCutWidth = 1.0; // width of tool blade when cutting off the work.
        this.simWorkBuffer = 1.0; // extended bottom side of the work by this amount.

        this.showWork = true;
        this.showTarget = false;
        this.targetSurf = null;

        this.numSweeps = 0;
        this.showingSweep = 0;
        this.removedVol = 0;
        this.remainingVol = 0;
        this.deviation = 0;
        this.toolIx = 0;
        this.showSweepVis = false;
        this.showPlanPath = true;
    }

    // [in] gui lilgui instance
    guiHook(gui) {
        gui.add(this, "resMm", [1e-3, 5e-2, 1e-2, 1e-1, 0.25, 0.5, 1]);

        gui.add(this, "genAllSweeps");
        gui.add(this, "genNextSweep");
        gui.add(this, "numSweeps").disable().listen();
        gui.add(this, "removedVol").name("Removed Vol (㎣)").decimals(9).disable().listen();
        gui.add(this, "remainingVol").name("Remaining Vol (㎣)").decimals(9).disable().listen();
        gui.add(this, "deviation").name("Deviation (mm)").decimals(3).disable().listen();
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
            const done = this.genNextSweep();
            if (done) {
                this.genSweeps = false;
            }
        }
    }

    // Setup new targets.
    //
    // [in] targetSurf: THREE.BufferGeometry
    // [in] baseZ: number, Z+ in machine coords where work coords Z=0 (bottom of the targer surface).
    // [in] aboveWorkSize: number, length of stock to be worked "above" baseZ plane. Note below-baseZ work will be still removed to cut off the work.
    // [in] stockDiameter: number, diameter of the stock.
    initPlan(targetSurf, baseZ, aboveWorkSize, stockDiameter) {
        this.targetSurf = targetSurf;
        this.stockDiameter = stockDiameter;
        this.baseZ = baseZ;
        this.aboveWorkSize = aboveWorkSize;
        this.gen = this.#pathGenerator();
    }

    genAllSweeps() {
        this.genSweeps = true;
    }

    genNextSweep() {
        if (!this.gen) {
            this.gen = this.#pathGenerator();
        }
        const res = this.gen.next();
        return res.done;
    }

    *#pathGenerator() {
        const t0 = performance.now();

        ////////////////////////////////////////
        // Init

        this.numSweeps = 0;
        this.removedVol = 0;
        this.toolIx = 0;

        const simStockLength = this.stockCutWidth + this.simWorkBuffer + this.aboveWorkSize;
        const stockGeom = generateStockGeom(this.stockDiameter / 2, simStockLength);
        translateGeom(stockGeom, new THREE.Vector3(0, 0, -(this.stockCutWidth + this.simWorkBuffer)));
        this.stockSurf = convGeomToSurf(stockGeom);
        const workVg = initVGForPoints(this.stockSurf, this.resMm);
        const targVg = workVg.clone();
        diceSurf(this.stockSurf, workVg);
        diceSurf(this.targetSurf, targVg);
        console.log(`stock: ${workVg.volume()} mm^3 (${workVg.count().toLocaleString("en-US")} voxels) / target: ${targVg.volume()} mm^3 (${targVg.count().toLocaleString("en-US")} voxels)`);

        this.trvg = new TrackingVoxelGrid(workVg.res, workVg.numX, workVg.numY, workVg.numZ, workVg.ofs.clone());
        this.trvg.setFromWorkAndTarget(workVg, targVg);
        this.trvg.setProtectedWorkBelowZ(-this.stockCutWidth);

        this.planPath = [];
        this.updateVis("work-vg", [createVgVis(this.trvg.extractWorkWithDeviation(), "work", "deviation")], this.showWork);
        this.updateVis("targ-vg", [createVgVis(this.trvg.extractTarget())], this.showTarget);
        this.updateVis("plan-path-vg", [createPathVis(this.planPath)], this.showPlanPath);

        ////////////////////////////////////////
        // Sweep generators

        // Pre/post-condition of sweep:
        // * tool is not touching work nor grinder
        // * de-energized
        // returns: true if sweep is committed, false if not

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
        const genPlanarSweep = (normal, offset, toolDiameter) => {
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

            const feedWidth = toolDiameter / 2;
            const segmentLength = toolDiameter / 2;
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
                    
                    const accessOk = !this.trvg.queryBlocked(createCylinderShape(segBeginBot, normal, toolDiameter / 2));
                    
                    // notBlocked is required when there's work-remaining overhang; technically the tool can cut the overhang too,
                    // but should be avoided to localize tool wear.
                    // const notBlocked = !this.trvg.queryBlocked(createELHShape(segBegin, segEnd, normal, this.toolDiameter / 2, outerRadius));
                    const notBlocked = true;
                    const collateralRange = 100;
                    const okToCut = this.trvg.queryOkToCutELH(segBeginBot, segEndBot, normal, toolDiameter / 2, feedDepth, collateralRange);
                    
                    const workOk = notBlocked && okToCut;

                    row.push({ accessOk, workOk, segBegin, segEnd, segBeginBot, segEndBot });
                }
                rows.push(row);
            }
            // console.log("sweep-rows", rows);

            // in planar sweep, tool is eroded only from the side.
            const maxWidthLoss = feedWidth * 0.1; // *0.5 is fine for EWR. but with coarse grid, needs to be smaller to not leave gaps between rows.
            const tipRefreshDist = Math.PI * (Math.pow(toolDiameter / 2, 2) - Math.pow(toolDiameter / 2 - maxWidthLoss, 2)) / this.ewrMax / feedWidth;
            
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

            const minSweepRemoveShapes = [];
            const maxSweepRemoveShapes = [];
            const pushRemoveMovement = (pathPt) => {
                if (prevPtTipPos === null) {
                    throw "remove path needs prevPtTipPos to be set by pushNonRemoveMovement";
                }
                minSweepRemoveShapes.push(createELHShape(prevPtTipPos, pathPt.tipPosW, pathPt.tipNormalW, toolDiameter / 2 - maxWidthLoss, 100));
                maxSweepRemoveShapes.push(createELHShape(prevPtTipPos, pathPt.tipPosW, pathPt.tipNormalW, toolDiameter / 2, 100));
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
                deltaWork: {max: maxSweepRemoveShapes, min: minSweepRemoveShapes},
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
        const genDrillSweep = (normal, toolDiameter) => {
            const rot = createRotationWithZ(normal);
            const scanDir0 = new THREE.Vector3(1, 0, 0).transformDirection(rot);
            const scanDir1 = new THREE.Vector3(0, 1, 0).transformDirection(rot);

            const halfDiagVec = new THREE.Vector3(this.trvg.numX, this.trvg.numY, this.trvg.numZ).multiplyScalar(this.trvg.res * 0.5);
            const trvgCenter = this.trvg.ofs.clone().add(halfDiagVec);
            const trvgRadius = halfDiagVec.length(); // TODO: proper bounds

            const scanRes = .5;
            const numScan0 = Math.ceil(trvgRadius * 2 / scanRes);
            const numScan1 = Math.ceil(trvgRadius * 2 / scanRes);
            const scanOrigin = trvgCenter.clone().sub(scanDir0.clone().multiplyScalar(trvgRadius)).sub(scanDir1.clone().multiplyScalar(trvgRadius));

            const holeDiameter = toolDiameter * 1.1;

            // grid query for drilling
            // if ok, just drill it with helical downwards path.
            const drillHoles = [];
            for (let ixScan0 = 0; ixScan0 < numScan0; ixScan0++) {
                for (let ixScan1 = 0; ixScan1 < numScan1; ixScan1++) {
                    const scanPt = scanOrigin.clone()
                        .add(scanDir0.clone().multiplyScalar(scanRes * ixScan0))
                        .add(scanDir1.clone().multiplyScalar(scanRes * ixScan1));
                    
                    const holeBot = scanPt.clone().sub(normal.clone().multiplyScalar(trvgRadius));
                    const holeTop = holeBot.clone().add(normal.clone().multiplyScalar(trvgRadius * 2));
                    const ok = this.trvg.queryOkToCutCylinder(holeBot, normal, holeDiameter / 2);
                    if (ok) {
                        //debug.vlogE(createErrorLocVis(holeBot, "red"));
                        drillHoles.push({
                            pos: scanPt,
                            holeBot,
                            holeTop,
                        });
                    } else {
                        //debug.vlogE(createErrorLocVis(holeBot, "blue"));
                    }
                }
            }
            console.log("drillHoles", drillHoles);
            if (drillHoles.length === 0) {
                return null;
            }

            // Generate paths
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

            const minSweepRemoveShapes = [];
            const maxSweepRemoveShapes = [];

            const pushNonRemoveMovement = (pathPt) => {
                sweepPath.push(withAxisValue(pathPt));
                prevPtTipPos = pathPt.tipPosW;
            };

            const evacuateOffset = normal.clone().multiplyScalar(3);

            drillHoles.forEach(hole => {
                pushNonRemoveMovement({
                    sweep: this.numSweeps,
                    group: `sweep-${this.numSweeps}`,
                    type: "move-in",
                    tipNormalW: normal,
                    tipPosW: hole.holeTop.clone().add(evacuateOffset),
                });

                // TODO: helical path
                minSweepRemoveShapes.push(createCylinderShape(hole.holeBot, normal, holeDiameter / 2));
                maxSweepRemoveShapes.push(createCylinderShape(hole.holeBot, normal, holeDiameter / 2));
                sweepPath.push(withAxisValue({
                    sweep: this.numSweeps,
                    group: `sweep-${this.numSweeps}`,
                    type: "remove-work",
                    tipNormalW: normal,
                    tipPosW: hole.holeBot,
                    toolRotDelta: 123, // TODO: Fix
                }));
                prevPtTipPos = hole.holeBot;

                pushNonRemoveMovement({
                    sweep: this.numSweeps,
                    group: `sweep-${this.numSweeps}`,
                    type: "move-out",
                    tipNormalW: normal,
                    tipPosW: hole.holeTop.clone().add(evacuateOffset),
                });
            });
            
            return {
                path: sweepPath,
                deltaWork: {max: maxSweepRemoveShapes, min: minSweepRemoveShapes},
                toolIx: toolIx,
                toolLength: toolLength,
            };
        };

        // Generate "cut" sweep.
        const genCutSweep = () => {
            // TODO: use rectangular tool for efficiency.
            // for now, just use circular tool because impl is simpler.
            const normal = new THREE.Vector3(1, 0, 0);
            const cutDir = new THREE.Vector3(0, 1, 0);

            const ctMin = this.trvg.queryWorkOffset(cutDir.clone().multiplyScalar(-1));
            const ctMax = this.trvg.queryWorkOffset(cutDir);
            const nrMin = this.trvg.queryWorkOffset(normal.clone().multiplyScalar(-1));
            const cutOffset = new THREE.Vector3(0, 0, -this.stockCutWidth * 0.5); // center of cut path

            const ptBeginBot = cutOffset.clone().add(cutDir.clone().multiplyScalar(-ctMin)).add(normal.clone().multiplyScalar(-nrMin));
            const ptEndBot = cutOffset.clone().add(cutDir.clone().multiplyScalar(ctMax)).add(normal.clone().multiplyScalar(-nrMin));

            const toolLength = this.toolLength;
            const toolIx = this.toolIx;
            const sweepPath = [];
            let prevPtTipPos = null;
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

            const minSweepRemoveShapes = [];
            const maxSweepRemoveShapes = [];
            const pushRemoveMovement = (pathPt) => {
                if (prevPtTipPos === null) {
                    throw "remove path needs prevPtTipPos to be set by pushNonRemoveMovement";
                }
                minSweepRemoveShapes.push(createELHShape(prevPtTipPos, pathPt.tipPosW, pathPt.tipNormalW, this.stockCutWidth / 2, 100));
                maxSweepRemoveShapes.push(createELHShape(prevPtTipPos, pathPt.tipPosW, pathPt.tipNormalW, this.stockCutWidth / 2, 100));
                sweepPath.push(withAxisValue(pathPt));
                prevPtTipPos = pathPt.tipPosW;
            };

            const pushNonRemoveMovement = (pathPt) => {
                sweepPath.push(withAxisValue(pathPt));
                prevPtTipPos = pathPt.tipPosW;
            };

            pushNonRemoveMovement({
                sweep: this.numSweeps,
                group: `sweep-${this.numSweeps}`,
                type: "move-in",
                tipNormalW: normal,
                tipPosW: ptBeginBot,
            });
            pushRemoveMovement({
                sweep: this.numSweeps,
                group: `sweep-${this.numSweeps}`,
                type: "remove-work",
                tipNormalW: normal,
                tipPosW: ptEndBot,
            });

            return {
                path: sweepPath,
                deltaWork: {max: maxSweepRemoveShapes, min: minSweepRemoveShapes},
                toolIx: toolIx,
                toolLength: toolLength,
                ignoreOvercutErrors: true,
            };
        };

        ////////////////////////////////////////
        // Main Loop

        // TODO: augment this from model normal features?
        const candidateNormals = [
            new THREE.Vector3(1, 0, 0),
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(-1, 0, 0),
            new THREE.Vector3(0, -1, 0),
            new THREE.Vector3(0, 0, 1),
        ];

        // Verify and commit sweep.
        // returns: true if committed, false if rejected.
        const tryCommitSweep = (sweep) => {
            // update sweep vis regardless of commit result
            this.updateVis("sweep-vis", sweepVises, this.showSweepVis);
            
            const volRemoved = this.trvg.commitRemoval(sweep.deltaWork.min, sweep.deltaWork.max, sweep.ignoreOvercutErrors ?? false);
            if (volRemoved === 0) {
                console.log("commit rejected, because work not removed");
                return false;
            } else {
                console.log(`commit sweep-${this.numSweeps} success`);
                // commit success
                this.removedVol += volRemoved;
                this.remainingVol = this.trvg.getRemainingWorkVol();
                this.planPath.push(...sweep.path);
                this.toolIx = sweep.toolIx;
                this.toolLength = sweep.toolLength;
                this.numSweeps++;
                this.showingSweep++;

                // update visualizations
                const workDeviation = this.trvg.extractWorkWithDeviation(true);
                this.updateVis("plan-path-vg", [createPathVis(this.planPath)], this.showPlanPath, false);
                this.updateVis("work-vg", [createVgVis(workDeviation, "work-vg", "deviation")], this.showWork);
                const lastPt = this.planPath[this.planPath.length - 1];
                this.updateVisTransforms(lastPt.tipPosW, lastPt.tipNormalW, this.toolLength);
                this.deviation = workDeviation.max();
                return true;
            }
        };

        // rough removals
        
        for (const normal of candidateNormals) {
            let offset = this.trvg.queryWorkOffset(normal);

            while (true) {
                const sweep = genPlanarSweep(normal, offset, this.toolDiameter);
                if (!sweep) {
                    break;
                }
                offset -= feedDepth;
                if (tryCommitSweep(sweep)) {
                    yield;
                }
            }
        }
            

        // rough drills
        for (const normal of candidateNormals) {
            const sweep = genDrillSweep(normal, this.toolDiameter / 4);
            this.updateVis("sweep-vis", sweepVises, this.showSweepVis);
            if (sweep) {
                if (tryCommitSweep(sweep)) {
                    yield;
                }
            }
        }

        // cut
        const sweep = genCutSweep();
        if (tryCommitSweep(sweep)) {
            yield;
        }

        // not done, but out of choices
        console.log(`possible sweep exhausted after ${(performance.now() - t0) / 1e3}sec`);
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



// Provides basic UI framework, 3D scene, and mesh/gcode I/O UI.
// Scene is in mm unit. Right-handed, Z+ up. Work-coordinates.
class View3D {
    constructor() {
        // Initialize basis
        this.init();

        this.visGroups = {};

        this.vlogErrors = [];
        this.lastNumVlogErrors = 0;
        
        // Visually log errors.
        // [in] obj: THREE.Object3D
        debug.vlogE = (obj) => {
            this.vlogErrors.push(obj);
            this.scene.add(obj);
        };

        // Setup extra permanent visualization
        const gridHelperBottom = new THREE.GridHelper(40, 4);
        gridHelperBottom.rotateX(Math.PI / 2);
        this.scene.add(gridHelperBottom);

        // Setup data
        this.models = {
            GT2_PULLEY: "GT2_pulley",
            HELICAL_GEAR: "helical_gear",
            HELICAL_GEAR_STANDING: "helical_gear_standing",
            LATTICE: "cube_lattice",
            BENCHY: "benchy_25p",
            BOLT_M3: "M3x10",
        };

        this.model = this.models.GT2_PULLEY;
        this.stockDiameter = 15;
        this.stockLength = 20;
        this.stockTopBuffer = 0.5;
        this.showStockMesh = true;
        this.showTargetMesh = true;
        this.updateVis("stock", [generateStock(this.stockDiameter / 2, this.stockLength)], this.showStockMesh);

        this.renderAoRadius = 5;
        this.renderDistFallOff = 1.0;
        this.renderAoItensity = 5;
        this.renderAoScreenRadius = false;

        // Setup modules & GUI
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
        gui.add(this, "stockDiameter", 1, 30, 0.1).onChange(_ => {
            this.#updateStockVis();
            this.modPlanner.initPlan(this.targetSurf, this.baseZ, this.aboveWorkSize, this.stockDiameter);
        });
        gui.add(this, "stockLength", 1, 30, 0.1).onChange(_ => {
            this.baseZ = this.stockLength - this.aboveWorkSize;
            this.#updateStockVis();
            this.modPlanner.initPlan(this.targetSurf, this.baseZ, this.aboveWorkSize, this.stockDiameter);
        });
        gui.add(this, "showStockMesh").onChange(v => {
            this.setVisVisibility("stock", v);
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
        this.camera = new THREE.OrthographicCamera(-25 * aspect, 25 * aspect, 25, -25, 1, 150);
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

        const light = new THREE.AmbientLight(0x808080); // soft white light
        this.scene.add(light);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(0, 0, 1);
        this.scene.add(directionalLight);

        const hemiLight = new THREE.HemisphereLight(0xffffbb, 0x080820, 1);
        this.scene.add(hemiLight);

        this.composer = new EffectComposer(this.renderer);
        const renderPass = new RenderPass(this.scene, this.camera);
        this.composer.addPass(renderPass);

        const n8aoPass = new N8AOPass(this.scene, this.camera, width, height);
        // We want "AO" effect to take effect at all scales, even though they're physically wrong.
        n8aoPass.configuration.screenSpaceRadius = true;
        n8aoPass.configuration.aoRadius = 64;
        n8aoPass.configuration.distanceFalloff = 0.2;
        n8aoPass.configuration.intensity = 5;
        this.composer.addPass(n8aoPass);

        const outputPass = new OutputPass();
        this.composer.addPass(outputPass);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);

        this.stats = new Stats();
        container.appendChild(this.stats.dom);

        const guiStatsEl = document.createElement('div');
        guiStatsEl.classList.add('gui-stats');

        window.addEventListener('resize', () => this.onWindowResize());
        Object.assign(window, { scene: this.scene });
    }

    #updateStockVis() {
        this.updateVis("stock", [generateStock(this.stockDiameter / 2, this.stockLength, this.baseZ)], this.showStockMesh);
    }

    loadStl(fname) {
        const loader = new STLLoader();
        loader.load(
            `models/${fname}.stl`,
            (geometry) => {
                this.targetSurf = convGeomToSurf(geometry);
                const aabb = computeAABB(this.targetSurf);
                // assuming aabb.min.z == 0.
                this.aboveWorkSize = aabb.max.z + this.stockTopBuffer;
                this.baseZ = this.stockLength - this.aboveWorkSize;
                this.#updateStockVis();
                this.modPlanner.initPlan(this.targetSurf, this.baseZ, this.aboveWorkSize, this.stockDiameter);

                const material = new THREE.MeshPhysicalMaterial({
                    color: 0xb2ffc8,
                    metalness: 0.1,
                    roughness: 0.8,
                    transparent: true,
                    opacity: 0.8,
                });
                this.updateVis("target", [new THREE.Mesh(geometry, material)]);
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
        this.composer.setSize(width, height);
    }

    animate() {
        this.modPlanner.animateHook();

        if (this.vlogErrors.length > this.lastNumVlogErrors) {
            console.warn(`${this.vlogErrors.length - this.lastNumVlogErrors} new errors`);
            this.lastNumVlogErrors = this.vlogErrors.length;
        }

        this.controls.update();
        this.composer.render();
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
