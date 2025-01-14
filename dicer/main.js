import * as THREE from 'three';
import { Vector2, Vector3, Quaternion, Matrix4 } from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

const fontLoader = new FontLoader();
let font = null;


const TG_FULL = 2; // fully occupied
const TG_PARTIAL = 1; // partially occupied
const TG_EMPTY = 0; // empty

const W_REMAINING = 1; // remaining work
const W_DONE = 0; // work done

const C_FULL_DONE = 0;  // current=full
const C_EMPTY_DONE = 1;  // current=empty
const C_EMPTY_REMAINING = 2; // current=non-empty
const C_PARTIAL_DONE = 1; // current=partial
const C_PARTIAL_REMAINING = 2; // current=full


// Generic voxel grid
// voxel-local coordinate
// voxel at (ix, iy, iz):
// * occupies volume: [i * res, (i + 1) * res)
// * has center: (i + 0.5) * res
//
// loc_world = rot * loc_vx + ofs
class VoxelGrid {
    // [in] res: voxel resolution
    // [in] numX, numY, numZ: grid dimensions
    // [in] ofs: voxel grid offset (local to world)
    // [in] rot: voxel grid rotation (local to world)
    constructor(res, numX, numY, numZ, ofs = new Vector3(), rot = new Quaternion().identity()) {
        this.res = res;
        this.numX = numX;
        this.numY = numY;
        this.numZ = numZ;
        this.data = new Uint8Array(numX * numY * numZ);
        this.ofs = ofs.clone();
        this.rot = rot.clone();
        this.lToW = new Matrix4().compose(ofs, rot, new Vector3(1, 1, 1));
        this.wToL = this.lToW.clone().invert();
    }

    isAxisAligned() {
        return this.rot.equals(new Quaternion().identity());
    }

    clone() {
        const vg = new VoxelGrid(this.res, this.numX, this.numY, this.numZ, this.ofs.clone(), this.rot.clone());
        vg.data.set(this.data);
        return vg;
    }

    saturateFill() {
        for (let i = 0; i < this.data.length; i++) {
            const v = this.data[i];
            this.data[i] = v > 0 ? 255 : 0;
        }
        return this;
    }

    saturateEmpty() {
        for (let i = 0; i < this.data.length; i++) {
            const v = this.data[i];
            this.data[i] = v < 255 ? 0 : 255;
        }
        return this;
    }

    sub(other) {
        for (let i = 0; i < this.data.length; i++) {
            this.data[i] = Math.max(0, this.data[i] - other.data[i]);
        }
        return this;
    }

    add(other) {
        for (let i = 0; i < this.data.length; i++) {
            this.data[i] = Math.min(255, this.data[i] + other.data[i]);
        }
        return this;
    }

    greaterOrEqual(other) {
        for (let i = 0; i < this.data.length; i++) {
            this.data[i] = (this.data[i] >= other.data[i]) ? 255 : 0;
        }
        return this;
    }

    multiplyScalar(s) {
        for (let i = 0; i < this.data.length; i++) {
            this.data[i] = Math.round(this.data[i] * s);
        }
        return this;
    }

    extendByRadiusXY(r) {
        const rN = r / this.res;
        const ref = this.clone();
        for (let iz = 0; iz < this.numZ; iz++) {
            for (let iy = 0; iy < this.numY; iy++) {
                for (let ix = 0; ix < this.numX; ix++) {
                    let accum = 0;
                    const rNc = Math.ceil(rN);
                    for (let dy = -rNc; dy <= rNc; dy++) {
                        const cy = iy + dy;
                        if (cy < 0 || cy >= this.numY) continue;
                        
                        for (let dx = -rNc; dx <= rNc; dx++) {
                            const cx = ix + dx;
                            if (cx < 0 || cx >= this.numX) continue;

                            const dist = Math.sqrt(dx * dx + dy * dy);
                            if (dist <= rN) {
                                const v = ref.get(cx, cy, iz);
                                accum = Math.max(accum, v);
                            }
                        }
                    }
                    this.set(ix, iy, iz, accum);
                }
            }
        }
        return this;
    }

    // return: number | null, max iz that has any non-zero cell.
    findMaxNonZeroZ() {
        for (let iz = this.numZ - 1; iz >= 0; iz--) {
            for (let iy = 0; iy < this.numY; iy++) {
                for (let ix = 0; ix < this.numX; ix++) {
                    if (this.get(ix, iy, iz) > 0) {
                        return iz;
                    }
                }
            }
        }
        return null;
    }

    // Scan towards Z- direction, keeping max value in the column.
    scanZMaxDesc() {
        for (let iy = 0; iy < this.numY; iy++) {
            for (let ix = 0; ix < this.numX; ix++) {
                let maxZ = 0;
                for (let iz = this.numZ - 1; iz >= 0; iz--) {
                    maxZ = Math.max(maxZ, this.get(ix, iy, iz));
                    this.set(ix, iy, iz, maxZ);
                }
            }
        }
    }
    
    /** Keep specified Z-layer, set 0 to all others. */
    filterZ(iz) {
        for (let i = 0; i < this.data.length; i++) {
            if (Math.floor(i / (this.numX * this.numY)) !== iz) {
                this.data[i] = 0;
            }
        }
        return this;
    }

    filterY(iy) {
        for (let i = 0; i < this.data.length; i++) {
            if (Math.floor(i / this.numX) % this.numY !== iy) {
                this.data[i] = 0;
            }
        }
        return this;
    }

    filterX(ix) {
        for (let i = 0; i < this.data.length; i++) {
            if (i % this.numX !== ix) {
                this.data[i] = 0;
            }
        }
        return this;
    }

    // Set cells inside the "extruded long hole" shape to val.
    // Note this method only test intersection of voxel center, rather than voxel volume.
    //
    // [in] p, q: start & end of the hole, in world coordinates
    // [in] n: normal of the hole extrusion, in world coordinates. Must be perpendicular to p-q line.
    // [in] r: radius of the hole
    // [in] val: value to set to cells
    setExtrudedLongHole(p, q, n, r, val) {
        if (q.clone().sub(p).dot(n) !== 0) {
            throw "Invalid extrusion normal";
        }

        const pL = p.clone().applyMatrix4(this.wToL);
        const qL = q.clone().applyMatrix4(this.wToL);
        const nL = n.clone().transformDirection(this.wToL);
        const dL = qL.clone().sub(pL);

        // Compute intersection of voxel-coordinate point and the ELH-shape.
        // Uses pL-origin coordinates for computation.
        //
        // [in] c: voxel-coordinate point
        // returns: true if intersects, false otherwise
        const isectLongHole = (c) => {
            const dc = c.clone().sub(pL);

            // reject half-space
            {
                const t = dc.dot(nL);
                if (t < 0) {
                    return false; // opposite region of the shape
                }
            }

            // Project onto the plane and turn into 2D problem.
            const cPlane = dc.clone().projectOnPlane(nL);
            
            // now find closest point on line 0-(q-p).
            let t = cPlane.dot(dL) / dL.dot(dL);
            t = Math.max(0, Math.min(1, t)); // limit to line segment (between p & q)
            const cLine = dL.clone().multiplyScalar(t);
            const dist = cLine.distanceTo(cPlane);
            return dist <= r;
        };

        // TODO: optimize. No need to scan all voxels.
        for (let iz = 0; iz < this.numZ; iz++) {
            for (let iy = 0; iy < this.numY; iy++) {
                for (let ix = 0; ix < this.numX; ix++) {
                    const locCenter = new Vector3(ix, iy, iz).addScalar(0.5).multiplyScalar(this.res);
                    if (isectLongHole(locCenter)) {
                        this.set(ix, iy, iz, val);
                    }
                }
            }
        }
    }

    /////
    // boolean ops

    not() {
        for (let i = 0; i < this.data.length; i++) {
            this.data[i] = this.data[i] > 0 ? 0 : 255;
        }
        return this;
    }

    and(other) {
        for (let i = 0; i < this.data.length; i++) {
            this.data[i] = (this.data[i] > 0 && other.data[i] > 0) ? 255 : 0;
        }
        return this;
    }

    or(other) {
        for (let i = 0; i < this.data.length; i++) {
            this.data[i] = (this.data[i] > 0 || other.data[i] > 0) ? 255 : 0;
        }
        return this;
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

    //////
    // spatial op

    volume() {
        return this.count() * this.res * this.res * this.res;
    }

    centerOf(ix, iy, iz) {
        return new Vector3(ix, iy, iz).addScalar(0.5).multiplyScalar(this.res).applyMatrix4(this.lToW);
    }

    getNearest(p) {
        const ix = p.clone().applyMatrix4(this.wToL).multiplyScalar(1 / this.res).floor();
        if (ix.x < 0 || ix.x >= this.numX) {
            return 0;
        }
        if (ix.y < 0 || ix.y >= this.numY) {
            return 0;
        }
        if (ix.z < 0 || ix.z >= this.numZ) {
            return 0;
        }
        return this.get(ix.x, ix.y, ix.z);
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
        const res = new VoxelGrid(this.res, this.numX, this.numY, this.numZ, this.ofs.clone());
        for (let i = 0; i < this.dataW.length; i++) {
            res.data[i] = this.dataW[i] === W_REMAINING ? 255 : 0;
        }
        return res;
    }

    // Scaffold for refactoring.
    // returns: VoxelGrid (0: empty, 128: partial, 255: full)
    extractTarget() {
        const res = new VoxelGrid(this.res, this.numX, this.numY, this.numZ, this.ofs.clone());
        for (let i = 0; i < this.dataT.length; i++) {
            res.data[i] = this.dataT[i] === TG_FULL ? 255 : (this.dataT[i] === TG_PARTIAL ? 128 : 0);
        }
        return res;
    }

    // Scaffold for refactoring.
    // returns: VoxelGrid (0: free, 255: maybe blocked)
    extractBlocked() {
        const res = new VoxelGrid(this.res, this.numX, this.numY, this.numZ, this.ofs.clone());
        for (let i = 0; i < this.dataW.length; i++) {
            const tst = this.dataT[i];
            const wst = this.dataW[i];

            if (tst === TG_EMPTY && wst === W_DONE) {
                res.data[i] = 0;
            } else {
                res.data[i] = 255;
            }
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
    commitRemoval(minGeoms, maxGeoms) {
        const minVg = new VoxelGrid(this.res, this.numX, this.numY, this.numZ, this.ofs.clone());
        const maxVg = new VoxelGrid(this.res, this.numX, this.numY, this.numZ, this.ofs.clone());
        minGeoms.forEach(g => {
            minVg.setExtrudedLongHole(g.p, g.q, g.n, g.r, 255);
        });
        maxGeoms.forEach(g => {
            maxVg.setExtrudedLongHole(g.p, g.q, g.n, g.r, 255);
        });

        console.log("delta-work-count-min", minVg.count());
        console.log("delta-work-count-max", maxVg.count());

        let errors = 0;
        for (let z = 0; z < this.numZ; z++) {
            for (let y = 0; y < this.numY; y++) {
                for (let x = 0; x < this.numX; x++) {
                    const i = x + y * this.numX + z * this.numX * this.numY;
                    if (maxVg.data[i] < minVg.data[i]) {
                        const p = this.centerOf(x, y, z);
                        const locator = `ix=(${x},${y},${z}), p=(${p.x},${p.y},${p.z})`;
                        throw `Min/max reversal, at ${locator}`;
                    }

                    // Compute conservative bounds that holds even with quantization error of minVg & maxVg.
                    let isMin = true;
                    let isMax = false;
                    for (let dz = -1; dz <= 1; dz++) {
                        for (let dy = -1; dy <= 1; dy++) {
                            for (let dx = -1; dx <= 1; dx++) {
                                const ox = x + dx;
                                const oy = y + dy;
                                const oz = z + dz;
                                if (ox < 0 || ox >= this.numX || oy < 0 || oy >= this.numY || oz < 0 || oz >= this.numZ) {
                                    continue;
                                }

                                const oi = ox + oy * this.numX + oz * this.numX * this.numY;
                                if (minVg.data[oi] === 0) {
                                    isMin = false;
                                }
                                if (maxVg.data[oi] === 255) {
                                    isMax = true;
                                }
                            }
                        }
                    }

                    // Commit.
                    if (isMax) {
                        // this voxel can be potentially uncertainly removed.
                        if (this.dataT[i] !== TG_EMPTY) {
                            const p = this.centerOf(x, y, z);
                            const locator = `ix=(${x},${y},${z}), p=(${p.x},${p.y},${p.z})`;
                            console.log(`isMin=${isMin}, isMax=${isMax}`);
                            for (let dz = -1; dz <= 1; dz++) {
                                for (let dy = -1; dy <= 1; dy++) {
                                    for (let dx = -1; dx <= 1; dx++) {
                                        const ox = x + dx;
                                        const oy = y + dy;
                                        const oz = z + dz;
                                        if (ox < 0 || ox >= this.numX || oy < 0 || oy >= this.numY || oz < 0 || oz >= this.numZ) {
                                            continue;
                                        }
        
                                        const oi = ox + oy * this.numX + oz * this.numX * this.numY;
                                        console.log(`o=(${ox},${oy},${oz}), minVg=${minVg.data[oi]}, maxVg=${maxVg.data[oi]}`);
                                    }
                                }
                            }
                            errors++;
                            //throw `Remove can affect protected region TG=${this.dataT[i]}, at ${locator}`;
                        }
                    }
                    
                    if (isMin) {
                        // this voxel will be definitely completely removed.
                        // (at this point. dataT === TG_EMPTY, because isMin => isMax.)
                        this.dataW[i] = W_DONE;
                    }
                }
            }
        }
        console.log(`commitRemoval errors=${errors}`);
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
        const isect = q => {
            const d = q.clone().sub(p);
            if (n.dot(d) < 0) {
                return false;
            }
            return d.projectOnPlane(n).length() <= r;
        };
        for (let iz = 0; iz < this.numZ; iz++) {
            for (let iy = 0; iy < this.numY; iy++) {
                for (let ix = 0; ix < this.numX; ix++) {
                    if (!isect(this.centerOf(ix, iy, iz))) {
                        continue;
                    }
                    if (this.#blockedConsevativeAt(ix, iy, iz)) {
                        return true;
                    }
                }
            }
        }
        return false;
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
        if (q.clone().sub(p).dot(n) !== 0) {
            throw "Invalid extrusion normal";
        }

        const dq = q.clone().sub(p);
        const isectELH = (x) => {
            const dx = x.clone().sub(p);
            // reject half-space
            if (n.dot(dx) < 0) {
                return false; // opposite region of the shape
            }
            if (n.dot(dx) > h) {
                return false; // too far
            }

            // Project onto the plane and turn into 2D problem.
            const xOnPlane = dx.clone().projectOnPlane(n);
            
            // now find closest point on line 0-dq.
            let t = xOnPlane.dot(dq) / dq.dot(dq);
            t = Math.max(0, Math.min(1, t)); // limit to line segment (between p & q)
            const xLine = dq.clone().multiplyScalar(t);
            const dist = xLine.distanceTo(xOnPlane);
            return dist <= r;
        };

        for (let iz = 0; iz < this.numZ; iz++) {
            for (let iy = 0; iy < this.numY; iy++) {
                for (let ix = 0; ix < this.numX; ix++) {
                    if (!isectELH(this.centerOf(ix, iy, iz))) {
                        continue;
                    }
                    if (this.#blockedConsevativeAt(ix, iy, iz)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    #blockedConsevativeAt(ix, iy, iz) {
        for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const ox = ix + dx;
                    const oy = iy + dy;
                    const oz = iz + dz;
                    if (ox < 0 || ox >= this.numX || oy < 0 || oy >= this.numY || oz < 0 || oz >= this.numZ) {
                        continue;
                    }
                    if (this.get(ox, oy, oz) !== C_EMPTY_DONE) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    #roughCutPreventedConservativeAt(ix, iy, iz) {
        for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const ox = ix + dx;
                    const oy = iy + dy;
                    const oz = iz + dz;
                    if (ox < 0 || ox >= this.numX || oy < 0 || oy >= this.numY || oz < 0 || oz >= this.numZ) {
                        continue;
                    }
                    const st = this.get(ox, oy, oz);
                    if (st !== C_EMPTY_DONE && st !== C_EMPTY_REMAINING) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    // Returns true if given ELH is accessible for work, conservatively.
    // accessible for work: work won't accidentally destroy protected region && region contains work.
    //
    // [in] p: start point
    // [in] q: end point
    // [in] n: direction (p-q must be perpendicular to n). LH is extruded along n+, by h.
    // [in] r: radius (>= 0)
    // [in] h: height (>= 0)
    // returns: true if accessible, false otherwise
    queryOkToCutELH(p, q, n, r, h) {
        // TODO: Refactor these isect code.
        if (q.clone().sub(p).dot(n) !== 0) {
            throw "Invalid extrusion normal";
        }

        const dq = q.clone().sub(p);
        const isectELH = (x) => {
            const dx = x.clone().sub(p);
            // reject half-space
            if (n.dot(dx) < 0) {
                return false; // opposite region of the shape
            }
            if (n.dot(dx) > h) {
                return false; // too far
            }

            // Project onto the plane and turn into 2D problem.
            const xOnPlane = dx.clone().projectOnPlane(n);
            
            // now find closest point on line 0-dq.
            let t = xOnPlane.dot(dq) / dq.dot(dq);
            t = Math.max(0, Math.min(1, t)); // limit to line segment (between p & q)
            const xLine = dq.clone().multiplyScalar(t);
            const dist = xLine.distanceTo(xOnPlane);
            return dist <= r;
        };

        let hasAnyWork = true;
        for (let iz = 0; iz < this.numZ; iz++) {
            for (let iy = 0; iy < this.numY; iy++) {
                for (let ix = 0; ix < this.numX; ix++) {
                    if (!isectELH(this.centerOf(ix, iy, iz))) {
                        continue;
                    }

                    if (this.#roughCutPreventedConservativeAt(ix, iy, iz)) {
                        return false;
                    }
                    if (this.getW(ix, iy, iz) === W_REMAINING) {
                        hasAnyWork = true;
                    }
                }
            }
        }
        return hasAnyWork;
    }

    /////
    // Single read/write

    // [in] ix, iy, iz: voxel index
    // [in] wst: one of W_REMAINING, or W_DONE
    setW(ix, iy, iz, wst) {
        this.dataW[ix + iy * this.numX + iz * this.numX * this.numY] = wst;
    }

    // [in] ix, iy, iz: voxel index
    // [in] tgt: one of TG_FULL, TG_PARTIAL, TG_EMPTY
    setT(ix, iy, iz, tst) {
        this.dataT[ix + iy * this.numX + iz * this.numX * this.numY] = tst;
    }

    // [in] ix, iy, iz: voxel index
    // returns: voxel value
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

    getNearest(p) {
        const ix = p.clone().sub(this.ofs).multiplyScalar(1 / this.res).floor();
        if (ix.x < 0 || ix.x >= this.numX) {
            return 0;
        }
        if (ix.y < 0 || ix.y >= this.numY) {
            return 0;
        }
        if (ix.z < 0 || ix.z >= this.numZ) {
            return 0;
        }
        return this.get(ix.x, ix.y, ix.z);
    }
}


const isectLine = (p, q, z) => {
    const d = q.z - p.z;
    const t = (d === 0) ? 0.5 : (z - p.z) / d;
    return p.clone().lerp(q, t);
};


const isectLine2 = (p, q, y) => {
    const d = q.y - p.y;
    const t = (d === 0) ? 0.5 : (y - p.y) / d;
    return p.clone().lerp(q, t);
};

// Computes AABB for bunch of points.
// [in] pts: [x0, y0, z0, x1, y1, z1, ...]
// returns: {min: Vector3, max: Vector3}
const computeAABB = (pts) => {
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < pts.length; i += 3) {
        const v = new Vector3(pts[i + 0], pts[i + 1], pts[i + 2]);
        min.min(v);
        max.max(v);
    }
    return { min, max };
};


// Initialize voxel grid for storing points.
// [in] pts: [x0, y0, z0, x1, y1, z1, ...]
// returns: VoxelGrid
const initVGForPoints = (pts, resMm) => {
    const MARGIN_MM = 1;
    const aabb = computeAABB(pts);
    return initVG(aabb, resMm, new Quaternion().identity(), MARGIN_MM);
};

// Initialize voxel grid for storing AABB.
// [in] aabbL: {min: Vector3, max: Vector3}, in local coordinates
// [in] res: voxel resolution
// [in] rotLToW: rotation from local to world, corresponding to aabbL
// [in] margin: margin, min distance between AABB & grid cells.
// returns: VoxelGrid
const initVG = (aabbL, res, rotLToW = new Quaternion().identity(), margin = 1) => {
    const min = aabbL.min.clone();
    const max = aabbL.max.clone();
    const center = min.clone().add(max).divideScalar(2);
    min.subScalar(margin);
    max.addScalar(margin);

    const numV = max.clone().sub(min).divideScalar(res).ceil();
    const gridMinL = center.clone().sub(numV.clone().multiplyScalar(res / 2));
    const gridMinW = gridMinL.clone().applyQuaternion(rotLToW);
    return new VoxelGrid(res, numV.x, numV.y, numV.z, gridMinW, rotLToW);
};


// [in] q: query point
// [in] xs: segment set [x0, x1], [x2, x3], ... (x0 < x1 < x2 < x3 < ...) even number of elements.
// [out] true if q is inside
const isValueInside = (q, xs) => {
    if (xs.length % 2 !== 0) {
        throw "Corrupt segment set"; // TODO: may need to handle gracefully.
    }

    for (let i = 0; i < xs.length; i += 2) {
        const x0 = xs[i];
        const x1 = xs[i + 1];
        if (q < x0) {
            return false;
        }
        if (q < x1) {
            return true;
        }
    }
    return false;
};


// TODO: this logic still missses tiny features like a screw lead. Need to sample many and reduce later.
// 0.5mm grid is obviously not enough to capture M1 screw lead mountains.
const diceSurf = (surf, vg) => {
    if (!vg.isAxisAligned()) {
        throw "diceSurf only supports axis-aligned VG";
    }

    console.log("dicing...");
    for (let iz = 0; iz < vg.numZ; iz++) {
        const sliceZ0 = vg.ofs.z + iz * vg.res;
        const sliceZ1 = vg.ofs.z + (iz + 1) * vg.res;

        //const cont = sliceSurfByPlane(surf, sliceZ);
        const contZ0 = sliceSurfByPlane(surf, sliceZ0);
        const contZ1 = sliceSurfByPlane(surf, sliceZ1);

        for (let iy = 0; iy < vg.numY; iy++) {
            const sliceY0 = vg.ofs.y + iy * vg.res;
            const sliceY1 = vg.ofs.y + (iy + 1) * vg.res;

            //const bnds = sliceContourByLine(cont, sliceY);
            const bnds00 = sliceContourByLine(contZ0, sliceY0);
            const bnds01 = sliceContourByLine(contZ1, sliceY0);
            const bnds10 = sliceContourByLine(contZ0, sliceY1);
            //console.log(`Z1=${sliceZ1}, Y1=${sliceY1}`);
            const bnds11 = sliceContourByLine(contZ1, sliceY1);

            for (let ix = 0; ix < vg.numX; ix++) {
                const sliceX0 = vg.ofs.x + ix * vg.res;
                const sliceX1 = vg.ofs.x + (ix + 1) * vg.res;

                let numInside = 0;
                numInside += isValueInside(sliceX0, bnds00) ? 1 : 0;
                numInside += isValueInside(sliceX0, bnds01) ? 1 : 0;
                numInside += isValueInside(sliceX0, bnds10) ? 1 : 0;
                numInside += isValueInside(sliceX0, bnds11) ? 1 : 0;
                numInside += isValueInside(sliceX1, bnds00) ? 1 : 0;
                numInside += isValueInside(sliceX1, bnds01) ? 1 : 0;
                numInside += isValueInside(sliceX1, bnds10) ? 1 : 0;
                numInside += isValueInside(sliceX1, bnds11) ? 1 : 0;

                //const isInside = isValueInside(sliceX, bnds);
                let cellV = 0;
                if (numInside === 8) {
                    cellV = 255;
                } else if (numInside > 0) {
                    cellV = 128;
                }
                vg.set(ix, iy, iz, cellV);
            }
        }
    }
    console.log(`dicing done; volume: ${vg.volume()} mm^3 (${vg.count()} voxels)`);
    return vg;
};


// contEdges: [x0, y0, x1, y1, ...]
// returns: seg set [x0, x1, x2, ...]
const sliceContourByLine = (contEdges, sliceY) => {
    const bnds = [];
    const numEdges = contEdges.length / 4;
    for (let i = 0; i < numEdges; i++) {
        const p0 = new Vector2(contEdges[4 * i + 0], contEdges[4 * i + 1]);
        const p1 = new Vector2(contEdges[4 * i + 2], contEdges[4 * i + 3]);

        const s0 = Math.sign(p0.y - sliceY);
        const s1 = Math.sign(p1.y - sliceY);

        // early exit
        if (s0 >= 0 && s1 >= 0) {
            continue;
        }
        if (s0 < 0 && s1 < 0) {
            continue;
        }

        const isect = isectLine2(p0, p1, sliceY);
        bnds.push({ x: isect.x, isEnter: s0 >= 0 });
    }
    bnds.sort((a, b) => a.x - b.x);

    const bndsClean = [];
    let insideness = 0; // supports non-manifold, nested surfaces by allowing multiple enter.
    bnds.forEach(b => {
        if (b.isEnter) {
            insideness++;
            if (insideness === 1) {
                bndsClean.push(b.x);
            }
        } else {
            insideness--;
            if (insideness === 0) {
                bndsClean.push(b.x);
            }
            if (insideness < 0) {
                // BUG: This cause false-positive, when a tangenting line intersects surface of a cylindrical mesh.
                // But looks like OK to ignore it for now. Need rigorous testing & numerical stability before prod.
                // temporarily disabled.
                //console.error("Corrupt surface data (hole)"); 
            }
        }
    });
    if (insideness !== 0) {
        console.error("Corrupt surface data (hole)");
    }
    if (bndsClean.length % 2 !== 0) {
        bndsClean.pop();
    }

    return bndsClean;
};


// surfTris: [x0, y0, z0, x1, y1, z1, ...]
// returns: contour edges
const sliceSurfByPlane = (surfTris, sliceZ) => {
    const segs = [];

    // tris are CCW.
    const numTris = surfTris.length / 9;
    for (let i = 0; i < numTris; i++) {
        const p0 = new Vector3(surfTris[9 * i + 0], surfTris[9 * i + 1], surfTris[9 * i + 2]);
        const p1 = new Vector3(surfTris[9 * i + 3], surfTris[9 * i + 4], surfTris[9 * i + 5]);
        const p2 = new Vector3(surfTris[9 * i + 6], surfTris[9 * i + 7], surfTris[9 * i + 8]);

        const s0 = Math.sign(p0.z - sliceZ);
        const s1 = Math.sign(p1.z - sliceZ);
        const s2 = Math.sign(p2.z - sliceZ);

        // early exit
        if (s0 >= 0 && s1 >= 0 && s2 >= 0) {
            continue;
        }
        if (s0 < 0 && s1 < 0 && s2 < 0) {
            continue;
        }

        // intersect 3 edges with
        let up = null;
        let down = null;
        if (s0 < 0 && s1 >= 0) {
            up = isectLine(p0, p1, sliceZ);
        } else if (s0 >= 0 && s1 < 0) {
            down = isectLine(p0, p1, sliceZ);
        }

        if (s1 < 0 && s2 >= 0) {
            up = isectLine(p1, p2, sliceZ);
        } else if (s1 >= 0 && s2 < 0) {
            down = isectLine(p1, p2, sliceZ);
        }

        if (s2 < 0 && s0 >= 0) {
            up = isectLine(p2, p0, sliceZ);
        } else if (s2 >= 0 && s0 < 0) {
            down = isectLine(p2, p0, sliceZ);
        }

        if (up === null || down === null) {
            throw "Degenerate triangle";
        }

        segs.push(down.x, down.y, up.x, up.y); // down -> up is CCW contor in XY plane.
    }

    return segs;
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

    const num = vg.count();
    const mesh = new THREE.InstancedMesh(cubeGeom, new THREE.MeshNormalMaterial(), num);
    let instanceIx = 0;
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
                    new THREE.Vector3(1, 1, 1).multiplyScalar(v / 255));
                mesh.setMatrixAt(instanceIx, mtx);
                instanceIx++;
            }
        }
    }

    const meshContainer = new THREE.Object3D();
    meshContainer.add(mesh);
    meshContainer.quaternion.copy(vg.rot);
    meshContainer.position.copy(vg.ofs);

    const axesHelper = new THREE.AxesHelper();
    axesHelper.scale.set(vg.res * vg.numX, vg.res * vg.numY, vg.res * vg.numZ);
    mesh.add(axesHelper);

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
// returns: THREE.Object3D
const createPathVis = (path) => {
    if (path.length === 0) {
        return new THREE.Object3D();
    }

    const vs = [];
    let prevTipPosW = path[0].tipPosW;
    for (let i = 1; i < path.length; i++) {
        const pt = path[i];
        if (pt.type === "remove-work") {
            vs.push(prevTipPosW.x, prevTipPosW.y, prevTipPosW.z);
            vs.push(pt.tipPosW.x, pt.tipPosW.y, pt.tipPosW.z);
        }
        prevTipPosW = pt.tipPosW;
    }

    const pathVis = new THREE.Object3D();

    // add remove path vis
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vs), 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x808080 });
    pathVis.add(new THREE.LineSegments(geom, mat));

    // add refresh path vis
    const sphGeom = new THREE.SphereGeometry(0.15);
    const sphMat = new THREE.MeshBasicMaterial({ color: 0x606060 });
    for (let i = 0; i < path.length; i++) {
        const pt = path[i];
        
        if (pt.type === "move-in") {
            const sph = new THREE.Mesh(sphGeom, sphMat);
            sph.position.copy(pt.tipPosW);
            pathVis.add(sph);
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


// orange-teal-purple color palette for ABC axes.
const axisColorA = new THREE.Color(0xe67e22);
const axisColorB = new THREE.Color(0x1abc9c);
const axisColorC = new THREE.Color(0x9b59b6);

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


////////////////////////////////////////////////////////////////////////////////
// 3D view

const Model = {
    GT2_PULLEY: "GT2_pulley",
    HELICAL_GEAR: "helical_gear",
    HELICAL_GEAR_STANDING: "helical_gear_standing",
    DICE_TOWER: "dice_tower",
    BENCHY: "benchy_25p",
    BOLT_M3: "M3x10",
};


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

const createErrorLocVis = (p, col) => {
    const sphGeom = new THREE.SphereGeometry(0.1);
    const sphMat = new THREE.MeshBasicMaterial({ color: col });
    const sph = new THREE.Mesh(sphGeom, sphMat);
    sph.position.copy(p);
    return sph;
}

/**
 * Scene is in mm unit. Right-handed, Z+ up. Work-coordinates.
 */
class View3D {
    constructor() {
        this.init();

        // machine geometries
        this.toolDiameter = 3;
        this.workOffset = new THREE.Vector3(20, 40, 20); // in machine coords
        this.wireCenter = new THREE.Vector3(30, 15, 30);
        this.stockCenter = new THREE.Vector3(10, 10, 10);

        this.workCoord = new THREE.Object3D();
        this.scene.add(this.workCoord);

        // work-coords
        this.visGroups = {};
        const gridHelperBottom = new THREE.GridHelper(40, 4);
        gridHelperBottom.rotateX(Math.PI / 2);
        this.workCoord.add(gridHelperBottom);

        // machine-coords
        this.tool = generateTool(30, this.toolDiameter);
        this.workCoord.add(this.tool);

        // configuration
        this.ewrMax = 0.3;

        // machine-state setup
        this.toolLength = 25;
        this.workCRot = 0;

        const stock = generateStock();
        this.objStock = stock;
        this.workCoord.add(stock);
        this.model = Model.GT2_PULLEY;
        this.showStockMesh = true;
        this.showTargetMesh = true;

        this.resMm = 0.5; // 0.25;
        this.showWork = true;
        this.showTarget = false;
        this.targetSurf = null;

        this.updateVisTransforms(new THREE.Vector3(-15, -15, 5), new THREE.Vector3(0, 0, 1), this.toolLength);
        this.numSweeps = 0;
        this.showingSweep = 0;
        this.removedVol = 0;
        this.toolIx = 0;
        this.showSweepAccess = false;
        this.showSweepSlice = false;
        this.showSweepRemoval = false;
        this.showPlanPath = true;

        this.scene.add(createErrorLocVis(new THREE.Vector3(4.25,2.25,0.7499999999999991), "violet"));

        this.initGui();
    }

    updateVisTransforms(tipPos, tipNormal, toolLength) {
        // regen tool; TODO: more efficient way
        this.workCoord.remove(this.tool);
        this.tool = generateTool(toolLength, this.toolDiameter);
        this.workCoord.add(this.tool);

        this.tool.position.copy(tipPos);
        this.tool.setRotationFromMatrix(createRotationWithZ(tipNormal));
    }

    initGui() {
        const gui = new GUI();
        gui.add(this, 'model', Model).onChange((model) => {
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

        gui.add(this, "resMm", [1e-3, 5e-2, 1e-2, 1e-1, 0.25, 0.5, 1]);
    
        gui.add(this, "initPlan");
        gui.add(this, "genNextSweep");
        gui.add(this, "genNextSweep10");
        gui.add(this, "genAllSweeps");
        gui.add(this, "numSweeps").disable().listen();
        gui.add(this, "removedVol").name("Removed Vol (㎣)").disable().listen();
        gui.add(this, "toolIx").disable().listen();
        // gui.add(this, "showingSweep", 0, this.numSweeps).step(1).listen();
        gui.add(this, "showTarget")
            .onChange(_ => this.setVisVisibility("targ-vg", this.showTarget))
            .listen();
        gui.add(this, "showWork")
            .onChange(_ => this.setVisVisibility("work-vg", this.showWork))
            .listen();
        gui.add(this, "showSweepAccess")
            .onChange(_ => this.setVisVisibility("sweep-access-vg", this.showSweepAccess))
            .listen();
        gui.add(this, "showSweepSlice")
            .onChange(_ => this.setVisVisibility("sweep-slice-vg", this.showSweepSlice))
            .listen();
        gui.add(this, "showSweepRemoval")
            .onChange(_ => this.setVisVisibility("sweep-removal-vg", this.showSweepRemoval))
            .listen();
        gui.add(this, "showPlanPath")
            .onChange(_ => this.setVisVisibility("plan-path-vg", this.showPlanPath))
            .listen();
        
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
            const outerRadius = 25; // Encompasses everything with a margin. TODO: use smaller to increase efficiency

            const rot = createRotationWithZ(normal);
            const feedDir = new THREE.Vector3(1, 0, 0).transformDirection(rot);
            const rowDir = new THREE.Vector3(0, 1, 0).transformDirection(rot);

            // rows : [row]
            // row : [segment]
            // segment : {
            //   accessOk: bool, // can enter this segment from left.
            //   workOk: bool, // work is available in this segment, and is not blocked.
            // }
            const rows = [];

            const feedWidth = this.toolDiameter / 2;
            const segmentLength = this.toolDiameter / 2;
            const numRows = Math.ceil(outerRadius * 2 / feedWidth);
            const numSegs = Math.ceil(outerRadius * 2 / segmentLength);
            const scanOrigin = normal.clone().multiplyScalar(offset)
                                    .sub(feedDir.clone().multiplyScalar(outerRadius))
                                    .sub(rowDir.clone().multiplyScalar(outerRadius));
            
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
                    
                    // const notBlocked = !this.trvg.queryBlockedELH(segBegin, segEnd, normal, this.toolDiameter / 2, outerRadius);
                    const notBlocked = true;
                    const collateralRange = 10;
                    const okToCut = this.trvg.queryOkToCutELH(segBeginBot, segEndBot, normal, this.toolDiameter / 2, collateralRange);
                    
                    const workOk = notBlocked && okToCut;

                    const col = new THREE.Color().setRGB(0, notBlocked ? 1 : 0, okToCut ? 1 : 0);
                    
                    sweepVises.push(createCylinderVis(segBegin, normal, this.toolDiameter / 2, col));

                    row.push({ accessOk, workOk, segBegin, segEnd, segBeginBot, segEndBot });
                }
                rows.push(row);
            }
            console.log("sweep-rows", rows);

            // in planar sweep, tool is eroded only from the side.
            const maxWidthLoss = feedWidth * 0.5;
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
                const ikResult = this.solveIk(isPosW ? pt.tipPosW : pt.tipPosM, pt.tipNormalW, toolLength, isPosW);
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
                if (prevPtTipPos !== null) {
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
                }

                sweepPath.push(pathPt);
                prevPtTipPos = pathPt.tipPosW;
            };

            const pushNonRemoveMovement = (pathPt) => {
                sweepPath.push(pathPt);
                prevPtTipPos = pathPt.tipPosW;
            };

            const evacuateOffset = normal.clone().multiplyScalar(3);

            for (let ixRow = 0; ixRow < rows.length; ixRow++) {
                const row = rows[ixRow];
                let entered = false;
                for (let ixSeg = 0; ixSeg < row.length; ixSeg++) {
                    const seg = row[ixSeg];
                    let pushThisSeg = false;
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
                            entered = true;
                            pushThisSeg = true;
                        }
                    } else {
                        if (seg.workOk && ixSeg !== row.length - 1) {
                            pushThisSeg = true;
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

                    if (pushThisSeg) {
                        const pt = withAxisValue({
                            sweep: this.numSweeps,
                            group: `sweep-${this.numSweeps}`,
                            type: "remove-work",
                            tipNormalW: normal,
                            tipPosW: seg.segEndBot,
                            toolRotDelta: 123, // TODO: Fix
                        });

                        pushRemoveMovement(pt);
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
                vis: {
                    //list: sweepVises,
                }
            };
        };

        let sweep = null;
        for (let i = 0; i < this.planner.normals.length; i++) {
            sweep = genPlanarSweep(this.planner.normals[this.planner.normalIndex], this.planner.offsets[this.planner.normalIndex]);
            this.planner.offsets[this.planner.normalIndex] -= feedDepth;
            if (sweep) {
                break;
            }
            this.planner.normalIndex = (this.planner.normalIndex + 1) % this.planner.normals.length;
        }

        this.updateVis("sweep-slice-vg", sweepVises, this.showSweepSlice);

        if (sweep === null) {
            console.log("possible sweep exhausted");
            return false;
        }

        console.log(`commiting sweep ${this.numSweeps}`, sweep);

        console.log("sweep-geoms-min", sweep.deltaWork.min);
        console.log("sweep-geoms-max", sweep.deltaWork.max);

        this.planPath.push(...sweep.path);
        this.toolIx = sweep.toolIx;
        this.toolLength = sweep.toolLength;

        // Convert sweep geoms into voxel.
        const volBeforeSweep = this.trvg.getRemainingWorkVol();
        this.trvg.commitRemoval(sweep.deltaWork.min, sweep.deltaWork.max);
        const volAfterSweep = this.trvg.getRemainingWorkVol();
        this.removedVol += volBeforeSweep - volAfterSweep;
        this.numSweeps++;
        this.showingSweep++;

        
        //this.updateVis("sweep-removal-vg", [createVgVis(sweep.deltaWork, "sweep-removal")], this.showSweepRemoval);

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
    solveIk(tipPos, tipNormalW, toolLength, isPosW) {
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

    copyGcode() {
        const prog = this.generateGcode();
        navigator.clipboard.writeText(prog);
    }

    sendGcodeToSim() {
        const prog = this.generateGcode();
        new BroadcastChannel("gcode").postMessage(prog);
    }

    generateGcode() {
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

        for (let i = 0; i < this.planPath.length; i++) {
            const pt = this.planPath[i];
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
        const parent = this.workCoord;
        if (this.visGroups[group]) {
            this.visGroups[group].forEach(v => parent.remove(v));
        }
        vs.forEach(v => {
            parent.add(v);
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
        if (this.genSweeps) {
            const res = this.genNextSweep();
            if (!res) {
                this.genSweeps = false; // done
            }
        }

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
        this.stats.update();
    }
}


////////////////////////////////////////////////////////////////////////////////
// entry point


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
