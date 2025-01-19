/**
 * Voxel operation and SDF (signed distance function) based queries.
 * 
 * See https://iquilezles.org/articles/distfunctions/ for nice introduction to SDF.
 */
import { Vector3 } from 'three';

/**
 * @param {Vector3} p Start point
 * @param {Vector3} n Direction (the cylinder extends infinitely towards n+ direction)
 * @param {number} r Radius
 * @returns {Object} Shape
 */
export const createCylinderShape = (p, n, r) => {
    return {type: "cylinder", p, n, r};
};

/**
 * @param {Vector3} p Start point
 * @param {Vector3} q End point
 * @param {Vector3} n Direction (p-q must be perpendicular to n). LH is extruded along n+, by h
 * @param {number} r Radius (>= 0)
 * @param {number} h Height (>= 0)
 * @returns {Object} Shape
 */
export const createELHShape = (p, q, n, r, h) => {
    return {type: "ELH", p, q, n, r, h};
};

/**
 * Returns a SDF for a shape.
 * @param {Object} shape Shape object, created by {@link createCylinderShape}, {@link createELHShape}, etc.
 * @returns {Function} SDF: Vector3 -> number (+: outside, 0: surface, -: inside)
 */
export const createSdf = (shape) => {
    switch (shape.type) {
        case "cylinder":
            return createSdfCylinder(shape.p, shape.n, shape.r);
        case "ELH":
            return createSdfElh(shape.p, shape.q, shape.n, shape.r, shape.h);
        default:
            throw `Unknown shape type: ${shape.type}`;
    }
};

/**
 * @param {Vector3} p Start point
 * @param {Vector3} n Direction (the cylinder extends infinitely towards n+ direction)
 * @param {number} r Radius
 * @returns {Function} SDF: Vector3 -> number (+: outside, 0: surface, -: inside)
 */
export const createSdfCylinder = (p, n, r) => {
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

/**
 * @param {Vector3} p Start point
 * @param {Vector3} q End point
 * @param {Vector3} n Direction (p-q must be perpendicular to n). LH is extruded along n+, by h
 * @param {number} r Radius (>= 0)
 * @param {number} h Height (>= 0)
 * @returns {Function} SDF: Vector3 -> number (+: outside, 0: surface, -: inside)
 */
export const createSdfElh = (p, q, n, r, h) => {
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

/**
 * Traverse all points that (sdf(p) <= offset), and call fn(ix, iy, iz)
 * @param {Object} vg VoxelGrid or TrackingVoxelGrid (must implement numX, numY, numZ, res, ofs, centerOf)
 * @param {Function} sdf number => number. Must be "true" SDF for this to work correctly
 * @param {number} offset Offset value
 * @param {Function} fn function(ix, iy, iz) => boolean. If true, stop traversal and return true
 * @returns {boolean} If true, stop traversal and return true
 */
export const traverseAllPointsInside = (vg, sdf, offset, fn) => {
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

/**
 * Returns true if all points (sdf(p) <= offset) are pred(p)
 * @param {Object} vg VoxelGrid or TrackingVoxelGrid (must implement numX, numY, numZ, res, ofs, centerOf)
 * @param {Function} sdf number => number
 * @param {number} offset Offset value
 * @param {Function} pred function(ix, iy, iz) => boolean
 * @returns {boolean} If true, stop traversal and return true
 */
export const everyPointInsideIs = (vg, sdf, offset, pred) => {
    return !traverseAllPointsInside(vg, sdf, offset, (ix, iy, iz) => {
        return !pred(ix, iy, iz);
    });
};

/**
 * Tests if any point inside satisfies the predicate
 * @param {Object} vg VoxelGrid or TrackingVoxelGrid (must implement numX, numY, numZ, res, ofs, centerOf)
 * @param {Function} sdf number => number
 * @param {number} offset Offset value
 * @param {Function} pred function(ix, iy, iz) => boolean
 * @returns {boolean} True if any point satisfies predicate
 */
export const anyPointInsideIs = (vg, sdf, offset, pred) => {
    return traverseAllPointsInside(vg, sdf, offset, (ix, iy, iz) => {
        return pred(ix, iy, iz);
    });
};

/**
 * Generic voxel grid
 * voxel-local coordinate
 * voxel at (ix, iy, iz):
 * - occupies volume: [i * res, (i + 1) * res)
 * - has center: (i + 0.5) * res
 * 
 * loc_world = loc_vx + ofs
 */
export class VoxelGrid {
    /**
     * @param {number} res Voxel resolution
     * @param {number} numX Grid dimension X
     * @param {number} numY Grid dimension Y
     * @param {number} numZ Grid dimension Z
     * @param {Vector3} [ofs=new Vector3()] Voxel grid offset (local to world)
     * @param {string} [type="u8"] Type of cell ("u8" | "f32")
     */
    constructor(res, numX, numY, numZ, ofs = new Vector3(), type = "u8") {
        this.res = res;
        this.numX = numX;
        this.numY = numY;
        this.numZ = numZ;
        this.ofs = ofs.clone();

        const ArrayConstructors = {
            "u8": Uint8Array,
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
     * @returns {VoxelGrid} New voxel grid instance
     */
    clone() {
        const vg = new VoxelGrid(this.res, this.numX, this.numY, this.numZ, this.ofs, this.type);
        vg.data.set(this.data);
        return vg;
    }

    /**
     * Set cells inside the given shape to val
     * @param {Object} shape Shape object
     * @param {number} val Value to set to cells
     * @param {string} roundMode "outside", "inside", or "nearest"
     */
    fillShape(shape, val, roundMode) {
        const sdf = createSdf(shape);
        let offset = null;
        const halfDiag = this.res * 0.5 * Math.sqrt(3);
        if (roundMode === "outside") {
            offset = halfDiag;
        } else if (roundMode === "inside") {
            offset = -halfDiag;
        } else if (roundMode === "nearest") {
            offset = 0;
        } else {
            throw `Unknown round mode: ${roundMode}`;
        }
        traverseAllPointsInside(this, sdf, offset, (ix, iy, iz) => {
            this.set(ix, iy, iz, val);
        });
    }

    /**
     * Set all cells to given value
     * @param {number} val Value to fill
     * @returns {VoxelGrid} this
     */
    fill(val) {
        this.data.fill(val);
        return this;
    }

    /**
     * Set value at given coordinates
     * @param {number} ix X coordinate
     * @param {number} iy Y coordinate
     * @param {number} iz Z coordinate
     * @param {number} val Value to set
     */
    set(ix, iy, iz, val) {
        this.data[ix + iy * this.numX + iz * this.numX * this.numY] = val;
    }

    /**
     * Get value at given coordinates
     * @param {number} ix X coordinate
     * @param {number} iy Y coordinate
     * @param {number} iz Z coordinate
     * @returns {number} Value at coordinates
     */
    get(ix, iy, iz) {
        return this.data[ix + iy * this.numX + iz * this.numX * this.numY];
    }

    /**
     * Count number of non-zero cells
     * @returns {number} Count of non-zero cells
     */
    count() {
        let cnt = 0;
        for (let i = 0; i < this.data.length; i++) {
            if (this.data[i] !== 0) {
                cnt++;
            }
        }
        return cnt;
    }

    /**
     * Count number of cells equal to given value
     * @param {number} val Value to compare against
     * @returns {number} Count of matching cells
     */
    countEq(val) {
        let cnt = 0;
        for (let i = 0; i < this.data.length; i++) {
            if (this.data[i] === val) {
                cnt++;
            }
        }
        return cnt;
    }

    /**
     * Count number of cells less than given value
     * @param {number} val Value to compare against
     * @returns {number} Count of cells less than val
     */
    countLessThan(val) {
        let cnt = 0;
        for (let i = 0; i < this.data.length; i++) {
            if (this.data[i] < val) {
                cnt++;
            }
        }
        return cnt;
    }

    /**
     * Get maximum value in grid
     * @returns {number} Maximum value
     */
    max() {
        let max = -Infinity;
        for (let i = 0; i < this.data.length; i++) {
            if (this.data[i] > max) {
                max = this.data[i];
            }
        }
        return max;
    }

    /**
     * Calculate volume of non-zero cells
     * @returns {number} Volume in cubic units
     */
    volume() {
        return this.count() * this.res * this.res * this.res;
    }

    /**
     * Get center coordinates of cell at given index
     * @param {number} ix X coordinate
     * @param {number} iy Y coordinate
     * @param {number} iz Z coordinate
     * @returns {Vector3} Center point of cell
     */
    centerOf(ix, iy, iz) {
        return new Vector3(ix, iy, iz).addScalar(0.5).multiplyScalar(this.res).add(this.ofs);
    }
}
