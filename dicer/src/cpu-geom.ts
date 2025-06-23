// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * CPU geometry operations including SDF (Signed Distance Function) and voxel grids.
 * 
 * See https://iquilezles.org/articles/distfunctions/ for nice introduction to SDF.
 */
import { Vector3 } from 'three';

interface CylinderShape {
    type: "cylinder";
    p: Vector3;
    n: Vector3;
    r: number;
    h: number;
}

interface ELHShape {
    type: "ELH";
    p: Vector3;
    q: Vector3;
    n: Vector3;
    r: number;
    h: number;
}

interface BoxShape {
    type: "box";
    center: Vector3;
    halfVec0: Vector3;
    halfVec1: Vector3;
    halfVec2: Vector3;
}

export type Shape = CylinderShape | ELHShape | BoxShape;

/**
 * @param p Start point
 * @param n Direction (the cylinder extends infinitely towards n+ direction)
 * @param r Radius
 * @param h Height
 */
export const createCylinderShape = (p: Vector3, n: Vector3, r: number, h: number): CylinderShape => {
    if (n.length() !== 1) {
        throw "Cylinder direction not normalized";
    }
    return { type: "cylinder", p, n, r, h };
};

/**
 * @param p Start point
 * @param q End point
 * @param n Direction (p-q must be perpendicular to n). LH is extruded along n+, by h
 * @param r Radius (>= 0)
 * @param h Height (>= 0)
 */
export const createELHShape = (p: Vector3, q: Vector3, n: Vector3, r: number, h: number): ELHShape => {
    if (n.length() !== 1) {
        throw "ELH direction not normalized";
    }
    if (q.clone().sub(p).dot(n) !== 0) {
        throw "Invalid extrusion normal";
    }
    if (q.distanceTo(p) < 1e-6) {
        throw "p-q too close";
    }
    return { type: "ELH", p, q, n, r, h };
};

/**
 * @param center Center of the box
 * @param halfVec0 Half vector of the box (must be perpendicular to halfVec1 & halfVec2)
 * @param halfVec1 Half vector of the box (must be perpendicular to halfVec0 & halfVec2)
 * @param halfVec2 Half vector of the box (must be perpendicular to halfVec0 & halfVec1)
 * @returns Shape
 */
export const createBoxShape = (center: Vector3, halfVec0: Vector3, halfVec1: Vector3, halfVec2: Vector3): BoxShape => {
    if (halfVec0.dot(halfVec1) !== 0 || halfVec0.dot(halfVec2) !== 0 || halfVec1.dot(halfVec2) !== 0) {
        throw "Half vectors must be perpendicular to each other";
    }
    return { type: "box", center, halfVec0, halfVec1, halfVec2 };
}

/**
 * Returns a SDF for a shape.
 * @param shape Shape object, created by {@link createCylinderShape}, {@link createELHShape}, etc.
 * @returns SDF: Vector3 -> number (+: outside, 0: surface, -: inside)
 */
export const createSdf = (shape: Shape): ((x: Vector3) => number) => {
    switch (shape.type) {
        case "cylinder":
            return createSdfCylinder(shape.p, shape.n, shape.r, shape.h);
        case "ELH":
            return createSdfElh(shape.p, shape.q, shape.n, shape.r, shape.h);
        case "box":
            return createSdfBox(shape.center, shape.halfVec0, shape.halfVec1, shape.halfVec2);
    }
};

/**
 * @param p Start point
 * @param n Direction (the cylinder extends infinitely towards n+ direction)
 * @param r Radius
 * @param h Height
 * @returns SDF: Vector3 -> number (+: outside, 0: surface, -: inside)
 */
const createSdfCylinder = (p: Vector3, n: Vector3, r: number, h: number): ((x: Vector3) => number) => {
    const temp = new Vector3();
    const sdf = x => {
        const dx = temp.copy(x).sub(p);

        // decompose into 1D + 2D
        const dx1 = dx.dot(n);
        const dx2 = dx.projectOnPlane(n); // destroys dx

        // 1D distance from interval [0, h]
        const d1 = Math.abs(dx1 - h * 0.5) - h * 0.5;

        // 2D distance from a circle r.
        const d2 = dx2.length() - r;

        // Combine 1D + 2D distances.
        return Math.min(Math.max(d1, d2), 0) + Math.hypot(Math.max(d1, 0), Math.max(d2, 0));
    };
    return sdf;
};

/**
 * @param p Start point
 * @param q End point
 * @param n Direction (p-q must be perpendicular to n). LH is extruded along n+, by h
 * @param r Radius (>= 0)
 * @param h Height (>= 0)
 * @returns SDF: Vector3 -> number (+: outside, 0: surface, -: inside)
 */
const createSdfElh = (p: Vector3, q: Vector3, n: Vector3, r: number, h: number): ((x: Vector3) => number) => {
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

/**
 * @param center Center of the box
 * @param halfVec0 Half vector of the box (must be perpendicular to halfVec1 & halfVec2)
 * @param halfVec1 Half vector of the box (must be perpendicular to halfVec0 & halfVec2)
 * @param halfVec2 Half vector of the box (must be perpendicular to halfVec0 & halfVec1)
 * @returns SDF: Vector3 -> number (+: outside, 0: surface, -: inside)
 */
const createSdfBox = (center: Vector3, halfVec0: Vector3, halfVec1: Vector3, halfVec2: Vector3): ((p: Vector3) => number) => {
    const unitVec0 = halfVec0.clone().normalize();
    const unitVec1 = halfVec1.clone().normalize();
    const unitVec2 = halfVec2.clone().normalize();
    const halfSize = new Vector3(halfVec0.length(), halfVec1.length(), halfVec2.length());

    const temp = new Vector3();
    const temp2 = new Vector3();
    const sdf = p => {
        let dp = temp.copy(p).sub(center);
        dp = temp.set(Math.abs(dp.dot(unitVec0)), Math.abs(dp.dot(unitVec1)), Math.abs(dp.dot(unitVec2)));
        dp.sub(halfSize);

        const dInside = Math.min(0, Math.max(dp.x, dp.y, dp.z));
        const dOutside = temp2.set(Math.max(0, dp.x), Math.max(0, dp.y), Math.max(0, dp.z)).length();
        return dInside + dOutside;
    };
    return sdf;
};

/**
 * CPU-backed voxel grid.
 * Supports very few operations, but can do per-cell read/write.
 * Can be copied to/from GPU buffer using {@link GpuKernels.copy}.
 * 
 * voxel at (ix, iy, iz):
 * - occupies volume: [ofs + ix * res, ofs + (ix + 1) * res)
 * - has center: ofs + (ix + 0.5) * res
 */
export class VoxelGridCpu {
    res: number;
    numX: number;
    numY: number;
    numZ: number;
    ofs: Vector3;
    type: "u32" | "f32";
    data: Uint32Array | Float32Array;

    /**
    * Create CPU-backed voxel grid.
    * @param res Voxel resolution
    * @param numX Grid dimension X
    * @param numY Grid dimension Y
    * @param numZ Grid dimension Z
    * @param ofs Voxel grid offset (local to world)
    * @param type Cell type
    */
    constructor(res: number, numX: number, numY: number, numZ: number, ofs: Vector3 = new Vector3(), type: "u32" | "f32" = "u32") {
        this.res = res;
        this.numX = numX;
        this.numY = numY;
        this.numZ = numZ;
        this.ofs = ofs.clone();
        const ArrayConstructors = {
            "u32": Uint32Array,
            "f32": Float32Array,
        };
        if (!ArrayConstructors[type]) {
            throw `Unknown voxel type: ${type}`;
        }
        this.type = type;
        this.data = new ArrayConstructors[type](numX * numY * numZ);
    }

    /**
     * Creates a deep copy of this voxel grid
     * @returns New voxel grid instance
     */
    clone(): VoxelGridCpu {
        const vg = new VoxelGridCpu(this.res, this.numX, this.numY, this.numZ, this.ofs, this.type);
        vg.data.set(this.data);
        return vg;
    }

    /**
     * Set value at given coordinates
     * @param ix X coordinate
     * @param iy Y coordinate
     * @param iz Z coordinate
     * @param val Value to set
     */
    set(ix: number, iy: number, iz: number, val: number) {
        this.data[ix + iy * this.numX + iz * this.numX * this.numY] = val;
    }

    /**
     * Get value at given coordinates
     * @param ix X coordinate
     * @param iy Y coordinate
     * @param iz Z coordinate
     * @returns Value at coordinates
     */
    get(ix: number, iy: number, iz: number): number {
        return this.data[ix + iy * this.numX + iz * this.numX * this.numY];
    }

    /**
     * Set all cells to given value
     * @param val Value to fill
     * @returns this
     */
    fill(val: number): VoxelGridCpu {
        this.data.fill(val);
        return this;
    }

    /**
     * Apply pred to all cells.
     */
    map(pred: (val: number, pos: Vector3) => number) {
        for (let iz = 0; iz < this.numZ; iz++) {
            for (let iy = 0; iy < this.numY; iy++) {
                for (let ix = 0; ix < this.numX; ix++) {
                    const pos = this.centerOf(ix, iy, iz);
                    const val = this.get(ix, iy, iz);
                    this.set(ix, iy, iz, pred(val, pos));
                }
            }
        }
    }

    /**
     * Count number of cells that satisfy the predicate.
     * @param pred Predicate function (val, pos) => result
     * @returns Count of cells that satisfy predicate
     */
    countIf(pred: (val: number, pos: Vector3) => boolean): number {
        let cnt = 0;
        for (let iz = 0; iz < this.numZ; iz++) {
            for (let iy = 0; iy < this.numY; iy++) {
                for (let ix = 0; ix < this.numX; ix++) {
                    const pos = this.centerOf(ix, iy, iz);
                    const val = this.get(ix, iy, iz);
                    if (pred(val, pos)) {
                        cnt++;
                    }
                }
            }
        }
        return cnt;
    }

    /**
     * Get maximum value in grid
     * @returns Maximum value
     */
    max(): number {
        let max = -Infinity;
        for (let i = 0; i < this.data.length; i++) {
            if (this.data[i] > max) {
                max = this.data[i];
            }
        }
        return max;
    }

    /**
     * Calculate volume of positive cells
     * @returns Volume in cubic units
     */
    volume(): number {
        return this.countIf((val) => val > 0) * this.res ** 3;
    }

    /**
     * Get center coordinates of cell at given index
     * @param ix X coordinate
     * @param iy Y coordinate
     * @param iz Z coordinate
     * @returns Center point of cell
     */
    centerOf(ix: number, iy: number, iz: number): Vector3 {
        return new Vector3(ix, iy, iz).addScalar(0.5).multiplyScalar(this.res).add(this.ofs);
    }
}