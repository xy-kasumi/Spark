/**
 * Pure geometry processing.
 * Use of three.js in this module is limited to primitives (Vectors, Matrices).
 */
import { Vector2, Vector3, Quaternion, Matrix4 } from 'three';

// voxel-local coordinate
// voxel at (ix, iy, iz):
// * occupies volume: [i * res, (i + 1) * res)
// * has center: (i + 0.5) * res
//
// loc_world = rot * loc_vx + ofs
export class VoxelGrid {
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

// Sample from ref into vg, using tri-state voxel.
// [out] vg: VoxelGrid
// [in] ref: VoxelGrid
// returns: VoxelGrid vg
export const resampleVG = (vg, ref) => {
    for (let iz = 0; iz < vg.numZ; iz++) {
        for (let iy = 0; iy < vg.numY; iy++) {
            for (let ix = 0; ix < vg.numX; ix++) {
                const p = vg.centerOf(ix, iy, iz);
                vg.set(ix, iy, iz, ref.getNearest(p));
            }
        }
    }
    return vg;
};


export class Octree {
    constructor(vg) {
        this.vg = vg;
        this.root = this.build(0, 0, 0, 0, this.vg.numX);
    }

    build(depth, xofs, yofs, zofs, cellSize) {
        if (cellSize === 1) {
            const val = this.vg.get(xofs, yofs, zofs);
            return {
                lv: depth,
                occupied: val === 255,
            };
        }

        const childCellSize = cellSize / 2;
        const children = [];
        let numOccupied = 0;
        let hasPartialChild = false;
        for (let i = 0; i < 8; i++) {
            const k = this.#decode3(i);
            const child = this.build(depth + 1, xofs + k.x * childCellSize, yofs + k.y * childCellSize, zofs + k.z * childCellSize, childCellSize);
            children.push(child);
            if (child.children) {
                hasPartialChild = true;
            } else {
                numOccupied += child.occupied ? 1 : 0;
            }
        }
        if (hasPartialChild || (1 <= numOccupied && numOccupied <= 7)) {
            return {
                lv: depth,
                children: children,
            };
        } else {
            return {
                lv: depth,
                occupied: numOccupied === 8,
            }
        }
    }

    countCells(target = this.root) {
        if (target.children) {
            return target.children.map(c => this.countCells(c)).reduce((a, b) => a + b, 0);
        } else {
            return 1;
        }
    }

    #encode3(x, y, z) {
        return z << 2 | y << 1 | x;
    }

    #decode3(code) {
        return {
            x: code & 1,
            y: (code >> 1) & 1,
            z: (code >> 2) & 1,
        };
    }
};


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
export const computeAABB = (pts) => {
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
export const initVGForPoints = (pts, resMm) => {
    const MARGIN_MM = 1;
    const aabb = computeAABB(pts);
    return initVG(aabb, resMm, new Quaternion().identity(), true, MARGIN_MM);
};

// Initialize voxel grid for storing AABB.
// [in] aabbL: {min: Vector3, max: Vector3}, in local coordinates
// [in] res: voxel resolution
// [in] rotLToW: rotation from local to world, corresponding to aabbL
// [in] powerOfTwoCube: if true, use power of 2 & same dims for grid.
// [in] margin: margin, min distance between AABB & grid cells.
// returns: VoxelGrid
export const initVG = (aabbL, res, rotLToW = new Quaternion().identity(), powerOfTwoCube = false, margin = 1) => {
    const min = aabbL.min.clone();
    const max = aabbL.max.clone();
    const center = min.clone().add(max).divideScalar(2);
    min.subScalar(margin);
    max.addScalar(margin);

    const numV = max.clone().sub(min).divideScalar(res).ceil();
    if (powerOfTwoCube) {
        const maxDim = Math.max(numV.x, numV.y, numV.z);
        const pow2Dim = Math.pow(2, Math.ceil(Math.log2(maxDim)));
        numV.set(pow2Dim, pow2Dim, pow2Dim);
    }

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
export const diceSurf = (surf, vg) => {
    if (!vg.isAxisAligned()) {
        throw "diceSurf only supports axis-aligned VG";
    }

    console.log("dicing...");
    for (let iz = 0; iz < vg.numZ; iz++) {
        const sliceZ = vg.ofs.z + (iz + 0.5) * vg.res;
        const sliceZ0 = vg.ofs.z + iz * vg.res;
        const sliceZ1 = vg.ofs.z + (iz + 1) * vg.res;

        //const cont = sliceSurfByPlane(surf, sliceZ);
        const contZ0 = sliceSurfByPlane(surf, sliceZ0);
        const contZ1 = sliceSurfByPlane(surf, sliceZ1);

        for (let iy = 0; iy < vg.numY; iy++) {
            const sliceY = vg.ofs.y + (iy + 0.5) * vg.res;
            const sliceY0 = vg.ofs.y + iy * vg.res;
            const sliceY1 = vg.ofs.y + (iy + 1) * vg.res;

            //const bnds = sliceContourByLine(cont, sliceY);
            const bnds00 = sliceContourByLine(contZ0, sliceY0);
            const bnds01 = sliceContourByLine(contZ1, sliceY0);
            const bnds10 = sliceContourByLine(contZ0, sliceY1);
            //console.log(`Z1=${sliceZ1}, Y1=${sliceY1}`);
            const bnds11 = sliceContourByLine(contZ1, sliceY1);

            for (let ix = 0; ix < vg.numX; ix++) {
                const sliceX = vg.ofs.x + (ix + 0.5) * vg.res;
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
    const oct = new Octree(vg);
    console.log(`octree done cells=${oct.countCells()}, #ratio=${oct.countCells() / vg.count()}`, oct);
    return vg;
};


// contEdges: [x0, y0, x1, y1, ...]
// returns: seg set [x0, x1, x2, ...]
export const sliceContourByLine = (contEdges, sliceY) => {
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
export const sliceSurfByPlane = (surfTris, sliceZ) => {
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
