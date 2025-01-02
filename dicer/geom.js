/**
 * Pure geometry processing.
 * Use of three.js in this module is limited to primitives (Vectors, Matrices).
 */
import { Vector2, Vector3 } from 'three';

// voxel at (ix, iy, iz):
// * occupies volume: [ofs + i * res, ofs + (i + 1) * res)
// * has center: ofs + (i + 0.5) * res
export class VoxelGrid {
    constructor(ofs, res, numX, numY, numZ) {
        this.ofs = ofs;
        this.res = res;
        this.numX = numX;
        this.numY = numY;
        this.numZ = numZ;
        this.data = new Uint8Array(numX * numY * numZ);
    }

    clone() {
        const vg = new VoxelGrid(this.ofs.clone(), this.res, this.numX, this.numY, this.numZ);
        vg.data.set(this.data);
        return vg;
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

    multiplyScalar(s) {
        for (let i = 0; i < this.data.length; i++) {
            this.data[i] = Math.round(this.data[i] * s);
        }
        return this;
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

    volume() {
        return this.count() * this.res * this.res * this.res;
    }
}

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


export const initVG = (surf, resMm) => {
    const MARGIN_MM = 1;

    // compute AABB
    const aabbMin = new Vector3(surf[0], surf[1], surf[2]);
    const aabbMax = new Vector3(surf[0], surf[1], surf[2]);
    for (let i = 1; i < surf.length / 3; i++) {
        const v = new Vector3(surf[3 * i + 0], surf[3 * i + 1], surf[3 * i + 2]);
        aabbMin.min(v);
        aabbMax.max(v);
    }
    console.log("AABB", aabbMin, aabbMax);

    aabbMin.subScalar(MARGIN_MM);
    aabbMax.addScalar(MARGIN_MM);
    const numV = aabbMax.clone().sub(aabbMin).divideScalar(resMm).ceil();
    console.log("VG size", numV);

    // To prepare for octree, get larger, cube grid with power of 2.
    const maxDim = Math.max(numV.x, numV.y, numV.z);
    const pow2Dim = Math.pow(2, Math.ceil(Math.log2(maxDim)));
    console.log("VG size/2^", pow2Dim);
    
    const gridMin = aabbMin.clone().add(aabbMax).divideScalar(2).subScalar(pow2Dim * resMm / 2);
    return new VoxelGrid(gridMin, resMm, pow2Dim, pow2Dim, pow2Dim);
};

export const diceSurf = (surf, vg) => {
    console.log("dicing...");
    for (let iz = 0; iz < vg.numZ; iz++) {
        const sliceZ = vg.ofs.z + (iz + 0.5) * vg.res;
        const cont = sliceSurfByPlane(surf, sliceZ);

        for (let iy = 0; iy < vg.numY; iy++) {
            const sliceY = vg.ofs.y + (iy + 0.5) * vg.res;
            const bnds = sliceContourByLine(cont, sliceY);

            let isOutside = true;
            for (let ix = 0; ix < vg.numX; ix++) {
                if (bnds.length === 0) {
                    vg.set(ix, iy, iz, 0);
                    continue;
                }

                const sliceX = vg.ofs.x + (ix + 0.5) * vg.res;

                // this loop is necessary for not breaking when handling smaller-than-cell features.
                let isInsideEvenOnce = !isOutside;
                while (bnds[0] <= sliceX) {
                    isOutside = !isOutside;
                    if (!isOutside) {
                        isInsideEvenOnce = true;
                    }
                    bnds.shift();
                }

                vg.set(ix, iy, iz, isInsideEvenOnce ? 255 : 0);
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
                console.error("Corrupt surface data (hole)");
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
