/**
 * WebGPU-accelerated voxel operations and SDF (signed distance function) based queries.
 * 
 * See https://iquilezles.org/articles/distfunctions/ for nice introduction to SDF.
 */
import { Vector3 } from 'three';


/**
 * @param {Vector3} p Start point
 * @param {Vector3} n Direction (the cylinder extends infinitely towards n+ direction)
 * @param {number} r Radius
 * @param {number} h Height
 * @returns {Object} Shape
 */
export const createCylinderShape = (p, n, r, h) => {
    return { type: "cylinder", p, n, r, h };
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
    return { type: "ELH", p, q, n, r, h };
};

/**
 * @param {Vector3} center Center of the box
 * @param {Vector3} halfVec0 Half vector of the box (must be perpendicular to halfVec1 & halfVec2)
 * @param {Vector3} halfVec1 Half vector of the box (must be perpendicular to halfVec0 & halfVec2)
 * @param {Vector3} halfVec2 Half vector of the box (must be perpendicular to halfVec0 & halfVec1)
 * @returns {Object} Shape
 */
export const createBoxShape = (center, halfVec0, halfVec1, halfVec2) => {
    return { type: "box", center, halfVec0, halfVec1, halfVec2 };
}

/**
 * Returns a SDF for a shape.
 * @param {Object} shape Shape object, created by {@link createCylinderShape}, {@link createELHShape}, etc.
 * @returns {Function} SDF: Vector3 -> number (+: outside, 0: surface, -: inside)
 */
export const createSdf = (shape) => {
    switch (shape.type) {
        case "cylinder":
            return createSdfCylinder(shape.p, shape.n, shape.r, shape.h);
        case "ELH":
            return createSdfElh(shape.p, shape.q, shape.n, shape.r, shape.h);
        case "box":
            return createSdfBox(shape.center, shape.halfVec0, shape.halfVec1, shape.halfVec2);
        default:
            throw `Unknown shape type: ${shape.type}`;
    }
};

/**
 * @param {Vector3} p Start point
 * @param {Vector3} n Direction (the cylinder extends infinitely towards n+ direction)
 * @param {number} r Radius
 * @param {number} h Height
 * @returns {Function} SDF: Vector3 -> number (+: outside, 0: surface, -: inside)
 */
export const createSdfCylinder = (p, n, r, h) => {
    if (n.length() !== 1) {
        throw "Cylinder direction not normalized";
    }
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

// The snippet assumes p, n, r, h are declared as uniform variables.
const wgslSdfCylinderSnippet = (inVar, outVar) => `
    {
        let dx = ${inVar} - p;
        // decompose into 1D + 2D
        let dx1 = dot(dx, n);
        let dx2 = dx - n * dx1;
        // 1D distance from interval [0, h]
        let d1 = abs(dx1 - h * 0.5) - h * 0.5;
        // 2D distance from a circle r.
        let d2 = length(dx2) - r;
        // Combine 1D + 2D distances.
        ${outVar} = min(max(d1, d2), 0) + length(max(vec2f(0), vec2f(d1, d2)));
    }
`;

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

// The snippet assumes p, q, n, r, h are declared as uniform variables.
const wgslSdfElhSnippet = (inVar, outVar) => `
    {
        let dq = q - p;
        let dqLenSq = dot(dq, dq);
        let dx = ${inVar} - p;
        // decompose into 2D + 1D
        let dx1 = dot(dx, n);
        let dx2 = dx - n * dx1;
        // 1D distance from interval [0, h]
        let d1 = abs(dx1 - h * 0.5) - h * 0.5;
        // 2D distance from long hole (0,dq,r)
        let t = clamp(dot(dx2, dq) / dqLenSq, 0, 1); // limit to line segment (between p & q)
        let d2 = distance(dx2, dq * t) - r;
        // Combine 1D + 2D distances.
        ${outVar} = min(max(d1, d2), 0) + length(max(vec2f(0), vec2f(d1, d2)));
    }
`;

/**
 * @param {Vector3} center Center of the box
 * @param {Vector3} halfVec0 Half vector of the box (must be perpendicular to halfVec1 & halfVec2)
 * @param {Vector3} halfVec1 Half vector of the box (must be perpendicular to halfVec0 & halfVec2)
 * @param {Vector3} halfVec2 Half vector of the box (must be perpendicular to halfVec0 & halfVec1)
 * @returns {Function} SDF: Vector3 -> number (+: outside, 0: surface, -: inside)
 */
export const createSdfBox = (center, halfVec0, halfVec1, halfVec2) => {
    if (halfVec0.dot(halfVec1) !== 0 || halfVec0.dot(halfVec2) !== 0 || halfVec1.dot(halfVec2) !== 0) {
        throw "Half vectors must be perpendicular to each other";
    }

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

// The snippet assumes center, halfVec0, halfVec1, halfVec2 are declared as uniform variables.
const wgslSdfBoxSnippet = (inVar, outVar) => `
    {
        let dx = ${inVar} - center;
        var dp = vec3f(
            dot(dx, normalize(halfVec0)),
            dot(dx, normalize(halfVec1)),
            dot(dx, normalize(halfVec2))
        );
        dp -= vec3f(length(halfVec0), length(halfVec1), length(halfVec2));

        let dInside = min(0, max(dp.x, max(dp.y, dp.z)));
        let dOutside = length(max(vec3f(0), dp));
        ${outVar} = dInside + dOutside;
    }
`;

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
                    blocks.push({ bx, by, bz });
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
 * CPU-backed voxel grid.
 * Supports very few operations, but can do per-cell read/write.
 * Can be copied to/from GPU buffer using {@link GpuKernels.copy}.
 * 
 * voxel at (ix, iy, iz):
 * - occupies volume: [ofs + ix * res, ofs + (ix + 1) * res)
 * - has center: ofs + (ix + 0.5) * res
 */
export class VoxelGridCpu {
    /**
    * Create CPU-backed voxel grid.
    * @param {number} res Voxel resolution
    * @param {number} numX Grid dimension X
    * @param {number} numY Grid dimension Y
    * @param {number} numZ Grid dimension Z
    * @param {Vector3} [ofs=new Vector3()] Voxel grid offset (local to world)
    * @param {string} Type of cell ("u32" | "f32")
    */
    constructor(res, numX, numY, numZ, ofs = new Vector3(), type = "u32") {
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
     * @returns {VoxelGridCpu} New voxel grid instance
     */
    clone() {
        const vg = new VoxelGridCpu(this.res, this.numX, this.numY, this.numZ, this.ofs, this.type);
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
     * @returns {VoxelGridCpu} this
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


/**
 * GPU-backed voxel grid.
 * Most of {@link GpuKernels} methods only support VoxelGrid.
 */
export class VoxelGridGpu {
    /**
     * @param {GpuKernels} kernels GpuKernels instance
     * @param {number} res Voxel resolution
     * @param {number} numX Grid dimension X
     * @param {number} numY Grid dimension Y
     * @param {number} numZ Grid dimension Z
     * @param {Vector3} [ofs=new Vector3()] Voxel grid offset (local to world)
     * @param {"u32" | "f32" | "vec3f"} type Type of cell
     */
    constructor(kernels, res, numX, numY, numZ, ofs = new Vector3(), type = "u32") {
        GpuKernels.checkAllowedType(type);

        this.kernels = kernels;
        this.res = res;
        this.numX = numX;
        this.numY = numY;
        this.numZ = numZ;
        this.ofs = ofs.clone();
        this.type = type;
        this.buffer = kernels.createBuffer(numX * numY * numZ * GpuKernels.sizeOfType(type));
    }
}


export class GpuKernels {
    constructor(device) {
        this.device = device;

        this.wgSize = 128;
        this.gridSnippet = `
            @group(0) @binding(100) var<uniform> nums: vec4u; // xyz: numX, numY, numZ. w: unused.
            @group(0) @binding(101) var<uniform> ofs_res: vec4f; // xyz: ofs, w: res

            fn decompose_ix(ix: u32) -> vec3u {
                return vec3u(ix % nums.x, (ix / nums.x) % nums.y, ix / (nums.x * nums.y));
            }

            fn compose_ix(ix3: vec3u) -> u32 {
                return ix3.x + ix3.y * nums.x + ix3.z * nums.x * nums.y;
            }

            fn cell_center(ix3: vec3u) -> vec3f {
                return vec3f(ix3) * ofs_res.w + ofs_res.xyz;
            }
        `;

        this.mapPipelines = {};
        this.map2Pipelines = {};
        this.reducePipelines = {};
        this.#compileFillPipeline();
        this.#compileJumpFloodPipeline();

        this.invalidValue = 65536; // used in boundOfAxis.

        this.registerMapFn("df_init", "u32", "vec4f", `if (vi > 0) { vo = vec4f(p, 0); } else { vo = vec4f(0, 0, 0, -1); }`);
        this.registerMapFn("df_to_dist", "vec4f", "f32", `vo = vi.w;`);
        this.registerMapFn("project_to_dir", "u32", "f32", `
            if (vi > 0) {
              vo = dot(dir, p);
            } else {
              vo = ${this.invalidValue};
            }
        `, { dir: "vec3f" });
        this.registerReduceFn("min_ignore_invalid", "f32", "1e5", `
            vo = min(
                select(vi1, 1e5, vi1 == ${this.invalidValue}),
                select(vi2, 1e5, vi2 == ${this.invalidValue}));
        `);
        this.registerReduceFn("max_ignore_invalid", "f32", "-1e5", `
            vo = max(
                select(vi1, -1e5, vi1 == ${this.invalidValue}),
                select(vi2, -1e5, vi2 == ${this.invalidValue}));
        `);

        this.registerMapFn("check_sdf_cylinder", "u32", "u32", `
            if (vi == 0) {
              vo = 0;
            } else {
              var d = f32(0);
              ${wgslSdfCylinderSnippet("p", "d")}
              vo = select(0u, 1u, d <= offset);
            }
        `, { p: "vec3f", n: "vec3f", r: "f32", h: "f32", offset: "f32" });
        this.registerMapFn("check_sdf_elh", "u32", "u32", `
            if (vi == 0) {
              vo = 0;
            } else {
              var d = f32(0);
              ${wgslSdfElhSnippet("p", "d")}
              vo = select(0u, 1u, d <= offset);
            }
        `, { p: "vec3f", q: "vec3f", n: "vec3f", r: "f32", h: "f32", offset: "f32" });
        this.registerMapFn("check_sdf_box", "u32", "u32", `
            if (vi == 0) {
              vo = 0;
            } else {
              var d = f32(0);
              ${wgslSdfBoxSnippet("p", "d")}
              vo = select(0u, 1u, d <= offset);
            }
        `, { center: "vec3f", halfVec0: "vec3f", halfVec1: "vec3f", halfVec2: "vec3f", offset: "f32" });
        this.registerReduceFn("sum", "u32", "0u", `
            vo = vi1 + vi2;
        `);
    }

    /**
     * Create new GPU-backed VoxelGrid, keeping shape of buf and optionally changing type.
     * @param {VoxelGridGpu | VoxelGridCpu} vg 
     * @param {"u32" | "f32" | "vec3f" | "vec4f" | null} [type=null] Type of cell ("u32" | "f32"). If null, same as buf.
     * @returns {VoxelGridGpu} New buffer
     */
    createLike(vg, type = null) {
        return new VoxelGridGpu(this, vg.res, vg.numX, vg.numY, vg.numZ, vg.ofs, type ?? vg.type);
    }

    /**
     * Create new CPU-backed VoxelGrid, keeping shape of buf.
     * @param {VoxelGridGpu | VoxelGridCpu} vg 
     * @returns {VoxelGridCpu} New buffer
     */
    createLikeCpu(vg) {
        if (vg.type === "vec3f") {
            throw new Error("Cannot create CPU-backed VoxelGrid for vec3f");
        }
        return new VoxelGridCpu(vg.res, vg.numX, vg.numY, vg.numZ, vg.ofs, vg.type);
    }

    /**
     * Copy data from inBuf to outBuf. This can cross CPU/GPU boundary.
     *
     * @param {VoxelGridGpu | VoxelGridCpu} inVg 
     * @param {VoxelGridGpu | VoxelGridCpu} outVg 
     * @returns {Promise<void>}
     * @async
     */
    async copy(inVg, outVg) {
        if (inVg === outVg) {
            return;
        }
        this.#checkGridCompat(inVg, outVg);
        const inBuffer = inVg instanceof VoxelGridCpu ? inVg.data.buffer : inVg.buffer;
        const outBuffer = outVg instanceof VoxelGridCpu ? outVg.data.buffer : outVg.buffer;
        await this.copyBuffer(inBuffer, outBuffer);
    }

    /**
     * Copy data from inBuf to outBuf. This can cross CPU/GPU boundary.
     * 
     * @param {ArrayBuffer | GPUBuffer} inBuf 
     * @param {ArrayBuffer | GPUBuffer} outBuf
     * @returns {Promise<void>}
     * @async
     */
    async copyBuffer(inBuf, outBuf) {
        if (inBuf === outBuf) {
            return;
        }
        const inIsCpu = inBuf instanceof ArrayBuffer;
        const outIsCpu = outBuf instanceof ArrayBuffer;
        const inSize = inIsCpu ? inBuf.byteLength : inBuf.size;
        const outSize = outIsCpu ? outBuf.byteLength : outBuf.size;
        if (inSize !== outSize) {
            throw new Error(`Buffer size mismatch: ${inSize} !== ${outSize}`);
        }
        const bufSize = inSize;

        if (inIsCpu && outIsCpu) {
            // CPU->CPU: just clone
            new Uint8Array(outBuf).set(new Uint8Array(inBuf));
        } else if (inIsCpu && !outIsCpu) {
            // CPU->GPU: direct API.
            this.device.queue.writeBuffer(outBuf, 0, inBuf, 0, bufSize);
        } else if (!inIsCpu && outIsCpu) {
            // GPU->CPU: via cpu-read buffer
            const tempBuf = this.createBufferForCpuRead(bufSize);
            const commandEncoder = this.device.createCommandEncoder();
            commandEncoder.copyBufferToBuffer(inBuf, 0, tempBuf, 0, bufSize);
            this.device.queue.submit([commandEncoder.finish()]);
            await this.device.queue.onSubmittedWorkDone();
            await tempBuf.mapAsync(GPUMapMode.READ);
            new Uint8Array(outBuf).set(new Uint8Array(tempBuf.getMappedRange(0, bufSize)));
            tempBuf.unmap();
            tempBuf.destroy();
        } else {
            // GPU->GPU: direct copy
            const commandEncoder = this.device.createCommandEncoder();
            commandEncoder.copyBufferToBuffer(inBuf, 0, outBuf, 0, bufSize);
            this.device.queue.submit([commandEncoder.finish()]);
            await this.device.queue.onSubmittedWorkDone();
        }
    }

    /**
     * Destroy & free VoxelGrid's backing buffer.
     * @param {VoxelGridGpu} vg 
     */
    destroy(vg) {
        vg.buffer.destroy();
        vg.buffer = null;
    }

    /**
     * Register WGSL snippet for use in {@link map}.
     * 
     * @param {string} name (not shared with registerMap2Fn)
     * @param {"u32" | "f32"} inType Type of input voxel
     * @param {"u32" | "f32"} outType Type of output voxel
     * @param {string} snippet (multi-line allowed)
     * @param {Object} uniforms Uniform variable defintions (can change for each invocation) {varName: type}
     * 
     * Snippet can use following variables:
     * - p: vec3f, voxel center position
     * - vi: value of the voxel
     * - vo: result
     * 
     * At the end of snippet, vo must be assigned a value.
     * e.g. "vo = 0; if (vi == 1) { vo = 1; } else if (p.x > 0.5) { vo = 2; }"
     * 
     * You can assume in/out are always different buffers.
     */
    registerMapFn(name, inType, outType, snippet, uniforms = {}) {
        if (this.mapPipelines[name]) {
            throw new Error(`Map fn "${name}" already registered`);
        }
        GpuKernels.checkAllowedType(inType);
        GpuKernels.checkAllowedType(outType);

        let uniformBindingId = 200;
        let unifDefs = [];
        let uniformBindings = {};
        let uniformIds = [];
        for (const [varName, type] of Object.entries(uniforms)) {
            GpuKernels.checkAllowedType(type);
            unifDefs.push(`@group(0) @binding(${uniformBindingId}) var<uniform> ${varName}: ${type};`);
            uniformBindings[varName] = {
                bindingId: uniformBindingId,
                type: type,
            };
            uniformIds.push(uniformBindingId);
            uniformBindingId++;
        }

        const code = `
            @group(0) @binding(0) var<storage, read_write> vs_in: array<${inType}>;
            @group(0) @binding(1) var<storage, read_write> vs_out: array<${outType}>;

            ${unifDefs.join("\n")}

            ${this.gridSnippet}

            @compute @workgroup_size(${this.wgSize})
            fn map_${name}(@builtin(global_invocation_id) id: vec3u) {
                let index = id.x;
                if (index >= arrayLength(&vs_in)) {
                    return;
                }

                let p = cell_center(decompose_ix(index));
                let vi = vs_in[index];
                var vo = ${outType}();
                {
                    ${snippet}
                }
                vs_out[index] = vo;
            }
        `;
        //console.log(code);
        const pipeline = this.#createPipeline(`map_${name}`, ["storage", "storage"], true, code, uniformIds);
        this.mapPipelines[name] = { pipeline, uniformBindings };
    }

    /**
     * Register WGSL expression snippet for use in {@link map2}.
     * 
     * @param {string} name (not shared with registerMapFn)
     * @param {"u32" | "f32"} inType1 Type of input voxel
     * @param {"u32" | "f32"} inType2 Type of input voxel
     * @param {"u32" | "f32"} outType Type of output voxel
     * @param {string} snippet (multi-line allowed)
     * 
     * Snippet can use following variables:
     * - p: vec3f, voxel center position
     * - vi1: value of the voxel
     * - vi2: value of the voxel
     * - vo: result
     * 
     * At the end of snippet, vo must be assigned a value.
     * e.g. "if (vi1 > 0 && vi2 > 0) { vo = 1; } else { vo = 0; }"
     * 
     * You can assume vi1/vi2/vo are always different buffers.
     */
    registerMap2Fn(name, inType1, inType2, outType, snippet) {
        if (this.map2Pipelines[name]) {
            throw new Error(`Map2 fn "${name}" already registered`);
        }
        GpuKernels.checkAllowedType(inType1);
        GpuKernels.checkAllowedType(inType2);
        GpuKernels.checkAllowedType(outType);

        this.map2Pipelines[name] = this.#createPipeline(`map2_${name}`, ["storage", "storage", "storage"], true, `
            @group(0) @binding(0) var<storage, read_write> vs_in1: array<${inType1}>;
            @group(0) @binding(1) var<storage, read_write> vs_in2: array<${inType2}>;
            @group(0) @binding(2) var<storage, read_write> vs_out: array<${outType}>;

            ${this.gridSnippet}

            @compute @workgroup_size(${this.wgSize})
            fn map2_${name}(@builtin(global_invocation_id) id: vec3u) {
                let index = id.x;
                if (index >= arrayLength(&vs_in1)) {
                    return;
                }
                
                let p = cell_center(decompose_ix(index));
                let vi1 = vs_in1[index];
                let vi2 = vs_in2[index];
                var vo = ${outType}();
                {
                    ${snippet}
                }
                vs_out[index] = vo;
            }
        `);
    }

    /**
     * Register WGSL snippet for use in {@link reduce}.
     * 
     * @param {string} name 
     * @param {"f32"} valType WGSL type signature of value type
     * @param {string} initVal expression of initial value
     * @param {string} snippet sentence(s) of reduce operation (multi-line allowed)
     * 
     * Snippet can use following variables:
     * - vi1: input value 1
     * - vi2: input value 2
     * - vo: result
     * 
     * At the end of snippet, vo must be assigned a value.
     * e.g. "vo = min(vi1, vi2);"
     * 
     * Snippet essentially implements reduction operator f(vi1,vi2)=vo.
     * For reduction to be correct, f must satisfy, forall a,b.
     * - f(a, b) == f(b, a)
     * - f(a, initVal) == a
     * - f(initVal, a) == a
     * 
     * Example of computing min: registerReduceFn("min", "float", "1e10", "vo = min(vi1, vi2);")
     */
    registerReduceFn(name, valType, initVal, snippet) {
        if (this.reducePipelines[name]) {
            throw new Error(`Reduce fn "${name}" already registered`);
        }

        this.reducePipelines[name] = this.#createPipeline(`reduce_${name}`, ["storage", "storage"], false, `
            var<workgroup> wg_buffer_accum: array<${valType}, ${this.wgSize}>;

            @group(0) @binding(0) var<storage, read_write> vs_in: array<${valType}>;
            @group(0) @binding(1) var<storage, read_write> vs_out: array<${valType}>;

            @compute @workgroup_size(${this.wgSize})
            fn reduce_${name}(@builtin(global_invocation_id) gid_raw: vec3u, @builtin(local_invocation_index) lid: u32) {
                let gid = gid_raw.x;

                var accum = ${initVal};
                if (gid < arrayLength(&vs_in)) {
                    accum = vs_in[gid];
                }
                wg_buffer_accum[lid] = accum;

                var stride = ${this.wgSize}u / 2u;
                while (stride > 0) {
                    workgroupBarrier();
                    if (lid < stride) {
                        let vi1 = wg_buffer_accum[lid];
                        let vi2 = wg_buffer_accum[lid + stride];
                        var vo = ${valType}();
                        {
                            ${snippet}
                        }
                        wg_buffer_accum[lid] = vo;
                    }
                    stride /= 2;
                }
                if (lid == 0) {
                    vs_out[gid / ${this.wgSize}] = wg_buffer_accum[0];
                }
            }
        `);
    }

    #compileFillPipeline() {
        const inType = "u32";
        // TODO: Need to support Shape injection, SDF in GPU, and offset injection.
        this.fillPipeline = this.#createPipeline(`fill`, ["storage"], true, `
            @group(0) @binding(0) var<storage, read_write> vs_out: array<${inType}>;

            ${this.gridSnippet}

            @compute @workgroup_size(${this.wgSize})
            fn fill(@builtin(global_invocation_id) id: vec3u) {
                let index = id.x;
                if (index >= arrayLength(&vs_out)) {
                    return;
                }

                let p = vec3f(decompose_ix(index)) * ofs_res.w + ofs_res.xyz;
                if (p.x < 10) {
                    vs_out[index] = 1;
                }
                /*
                if (sdf(p) + offset < 0) {
                    vs_out[index] = 1;
                }
                */
            }
        `);
    }

    #compileJumpFloodPipeline() {
        this.jumpFloodPipeline = this.#createPipeline(`jump_flood`, ["storage"], true, `
            @group(0) @binding(0) var<storage, read_write> df: array<vec4f>; // xyz:seed, w:dist (-1 is invalid)

            ${this.gridSnippet} // + nums.w contain jump step

            @compute @workgroup_size(${this.wgSize})
            fn jump_flood(@builtin(global_invocation_id) id: vec3u) {
                let ix = id.x;
                if (ix >= arrayLength(&df)) {
                    return;
                }

                let ix3 = decompose_ix(ix);
                let p = cell_center(ix3);
                var sd = df[ix];
                if (sd.w == 0) {
                    return; // no change needed
                }

                let offsets = array<vec3i, 6>(
                    vec3i(-1, 0, 0),
                    vec3i(1, 0, 0),
                    vec3i(0, -1, 0),
                    vec3i(0, 1, 0),
                    vec3i(0, 0, -1),
                    vec3i(0, 0, 1),
                );
                for (var i = 0; i < 6; i++) {
                    let nix3 = vec3i(ix3) + offsets[i] * i32(nums.w);
                    if (any(nix3 < vec3i(0)) || any(nix3 >= vec3i(nums.xyz))) {
                        continue; // neighbor is out of bound
                    }
                    let nix = compose_ix(vec3u(nix3));
                    let nsd = df[nix];
                    if (nsd.w < 0) {
                        continue; // neighbor is invalid
                    }
                    let nd = distance(nsd.xyz, p);
                    if (sd.w < 0 || nd < sd.w) {
                        sd = vec4f(nsd.xyz, nd);  // closer seed found
                    }
                }
                df[ix] = sd;
            }
        `);
    }


    /**
     * 
     * @param {string} fnName 
     * @param {VoxelGridGpu} inVg 
     * @param {VoxelGridGpu} outVg
     * @param {Object} uniforms Uniform variable values.
     * @returns {Promise<void>}
     * @async
     */
    async map(fnName, inVg, outVg, uniforms = {}) {
        const grid = this.#checkGridCompat(inVg, outVg);
        if (!this.mapPipelines[fnName]) {
            throw new Error(`Map fn "${fnName}" not registered`);
        }
        const { pipeline, uniformBindings } = this.mapPipelines[fnName];

        // Check uniform type compatibility.
        const unusedVars = new Set(Object.keys(uniforms)).difference(new Set(Object.keys(uniformBindings)));
        if (unusedVars.size > 0) {
            console.warn("Unused uniform variables: ", unusedVars);
        }
        for (const [varName, binding] of Object.entries(uniformBindings)) {
            if (!uniforms[varName]) {
                throw new Error(`Required uniform variable "${varName}" not provided`);
            }
            const val = uniforms[varName];
            if (binding.type === "vec3f" && !(val instanceof Vector3)) {
                throw new Error(`Uniform variable "${varName}: vec3f" must be a Vector3`);
            }
            if (binding.type === "f32" && typeof val !== "number") {
                throw new Error(`Uniform variable "${varName}: f32" must be a number`);
            }
        }

        let tmpBuf = null;
        if (outVg === inVg) {
            tmpBuf = this.createLike(inVg);
            outVg = tmpBuf;
        }

        const numsBuf = this.createUniformBuffer(32, (ptr) => {
            new Uint32Array(ptr, 0, 4).set([
                grid.numX, grid.numY, grid.numZ, 0,
            ]);
        });
        const ofsBuf = this.createUniformBuffer(32, (ptr) => {
            new Float32Array(ptr, 0, 4).set([
                grid.ofs.x, grid.ofs.y, grid.ofs.z, grid.res,
            ]);
        });


        const additionalEntries = [];
        for (const [varName, binding] of Object.entries(uniformBindings)) {
            const { bindingId, type } = binding;
            let buf = null;
            if (type === "vec3f") {
                buf = this.createUniformBuffer(32, (ptr) => {
                    new Float32Array(ptr, 0, 4).set([
                        uniforms[varName].x, uniforms[varName].y, uniforms[varName].z, 0,
                    ]);
                });
            } else if (type === "f32") {
                buf = this.createUniformBuffer(32, (ptr) => {
                    new Float32Array(ptr, 0, 1).set([uniforms[varName]]);
                });
            }
            additionalEntries.push([bindingId, buf]);
        }

        try {
            const commandEncoder = this.device.createCommandEncoder();
            this.#dispatchKernel(commandEncoder, pipeline, [inVg.buffer, outVg.buffer], grid.numX * grid.numY * grid.numZ, numsBuf, ofsBuf, additionalEntries);
            this.device.queue.submit([commandEncoder.finish()]);
            if (inVg === outVg) {
                await this.copy(tmpBuf, inVg);
                this.destroy(tmpBuf);
            }
        } finally {
            numsBuf.destroy();
            ofsBuf.destroy();
            for (const [_, buf] of additionalEntries) {
                buf.destroy();
            }
        }
    }

    /**
     * 
     * @param {string} fnName 
     * @param {VoxelGridGpu} inVg1 
     * @param {VoxelGridGpu} inVg2 
     * @param {VoxelGridGpu} outVg 
     * @returns {Promise<void>}
     * @async
     */
    async map2(fnName, inVg1, inVg2, outVg = inVg1) {
        const grid = this.#checkGridCompat(inVg1, inVg2, outVg);
        if (!this.map2Pipelines[fnName]) {
            throw new Error(`Map2 fn "${fnName}" not registered`);
        }

        let tmpBuf = null;
        if (outVg === inVg1) {
            tmpBuf = this.createLike(inVg1);
            outVg = tmpBuf;
        } else if (outVg === inVg2) {
            tmpBuf = this.createLike(inVg2);
            outVg = tmpBuf;
        }

        const numsBuf = this.createUniformBuffer(32, (ptr) => {
            new Uint32Array(ptr, 0, 4).set([
                grid.numX, grid.numY, grid.numZ, 0,
            ]);
        });
        const ofsBuf = this.createUniformBuffer(32, (ptr) => {
            new Float32Array(ptr, 0, 4).set([
                grid.ofs.x, grid.ofs.y, grid.ofs.z, grid.res,
            ]);
        });
        try {
            const commandEncoder = this.device.createCommandEncoder();
            this.#dispatchKernel(commandEncoder, this.map2Pipelines[fnName], [inVg1.buffer, inVg2.buffer, outVg.buffer], grid.numX * grid.numY * grid.numZ, numsBuf, ofsBuf);
            this.device.queue.submit([commandEncoder.finish()]);
            if (inVg1 === outVg) {
                await this.copy(tmpBuf, inVg1);
                this.destroy(tmpBuf);
            } else if (inVg2 === outVg) {
                await this.copy(tmpBuf, inVg2);
                this.destroy(tmpBuf);
            }
        } finally {
            numsBuf.destroy();
            ofsBuf.destroy();
        }
    }

    /**
     * 
     * @param {string} fnName Function registered in {@link registerReduceFn}.
     * @param {VoxelGridGpu} inVg 
     * @returns {Promise<number>}
     * @async
     */
    async reduce(fnName, inVg) {
        if (!this.reducePipelines[fnName]) {
            throw new Error(`Reduce fn "${fnName}" not registered`);
        }

        // TODO: These should be buffer, instead of VG.
        const tempVgs = [
            this.createLike(inVg),
            this.createLike(inVg),
        ];

        await this.copy(inVg, tempVgs[0]);
        let activeBufIx = 0;

        try {
            const commandEncoder = this.device.createCommandEncoder();
            let numElems = inVg.numX * inVg.numY * inVg.numZ;
            while (numElems > 1) {
                this.#dispatchKernel(commandEncoder, this.reducePipelines[fnName], [tempVgs[activeBufIx].buffer, tempVgs[1 - activeBufIx].buffer], numElems);
                activeBufIx = 1 - activeBufIx;
                numElems = Math.ceil(numElems / this.wgSize);
            }
            this.device.queue.submit([commandEncoder.finish()]);
            await this.device.queue.onSubmittedWorkDone();
            const readBuf = this.createBufferForCpuRead(inVg.buffer.size);
            await this.copyBuffer(tempVgs[activeBufIx].buffer, readBuf);
            await readBuf.mapAsync(GPUMapMode.READ);
            const result = new Float32Array(readBuf.getMappedRange(0, 4))[0];
            readBuf.unmap();
            readBuf.destroy();
            return result;
        } finally {
            this.destroy(tempVgs[0]);
            this.destroy(tempVgs[1]);
        }
    }

    /**
     * Get range of non-zero cells along dir.
     * 
     * @param {string} dir Unit vector representing axis to check.
     * @param {VoxelGridGpu} inVg non-zero means existence.
     * @param {"in" | "out" | "nearest"} boundary
     * @returns {Promise<{min: number, max: number}>}
     * @async
     */
    async boundOfAxis(dir, inVg, boundary) {
        const projs = this.createLike(inVg, "f32");
        await this.map("project_to_dir", inVg, projs, { dir });
        const min = await this.reduce("min_ignore_invalid", projs);
        const max = await this.reduce("max_ignore_invalid", projs);
        this.destroy(projs);
        const maxVoxelCenterOfs = inVg.res * Math.sqrt(3) * 0.5;
        const offset = {
            "in": -maxVoxelCenterOfs,
            "out": maxVoxelCenterOfs,
            "nearest": 0,
        }[boundary];
        return { min: min - offset, max: max + offset };
    }

    /**
     * Checks if any voxel exists inside shape.
     * 
     * @param {Object} shape
     * @param {VoxelGridGpu} inVg(u32). Non-zero means exist.
     * @param {"in" | "out" | "nearest"} boundary
     * @returns {Promise<boolean>}
     * @async
     */
    async any(shape, inVg, boundary) {
        // TODO: Gen candidate big voxels, and only dispatch them.
        const maxVoxelCenterOfs = inVg.res * Math.sqrt(3) * 0.5;
        const offset = {
            "in": -maxVoxelCenterOfs,
            "out": maxVoxelCenterOfs,
            "nearest": 0,
        }[boundary];

        const options = { offset };
        if (shape.type === "cylinder") {
            options.p = shape.p;
            options.n = shape.n;
            options.r = shape.r;
            options.h = shape.h;
        } else if (shape.type === "elh") {
            options.p = shape.p;
            options.q = shape.q;
            options.n = shape.n;
            options.r = shape.r;
            options.h = shape.h;
        } else if (shape.type === "box") {
            options.center = shape.center;
            options.halfVec0 = shape.halfVec0;
            options.halfVec1 = shape.halfVec1;
            options.halfVec2 = shape.halfVec2;
        } else {
            throw new Error(`Unsupported shape type: ${shape.type}`);
        }

        const flagVg = this.createLike(inVg, "u32");
        await this.map("check_sdf_" + shape.type, inVg, flagVg, options);
        const count = await this.reduce("sum", flagVg);
        this.destroy(flagVg);
        return count > 0;
    }

    /**
     * Writes "1" to all voxels contained in shape.
     * 
     * @param {Object} shape 
     * @param {VoxelGridGpu} vg (in-place)
     * @param {"in" | "out" | "nearest"} boundary 
     * @returns {Promise<void>}
     * @async
     */
    async fill(shape, vg, boundary) {
        // TODO: Gen candidate big voxels & dispatch them.

        const numsBuf = this.createUniformBuffer(32, (ptr) => {
            new Uint32Array(ptr, 0, 4).set([
                vg.numX, vg.numY, vg.numZ, 0,
            ]);
        });
        const ofsBuf = this.createUniformBuffer(32, (ptr) => {
            new Float32Array(ptr, 0, 4).set([
                vg.ofs.x, vg.ofs.y, vg.ofs.z, vg.res,
            ]);
        });
        try {
            const commandEncoder = this.device.createCommandEncoder();
            this.#dispatchKernel(commandEncoder, this.fillPipeline, [vg.buffer], vg.numX * vg.numY * vg.numZ, numsBuf, ofsBuf);
            this.device.queue.submit([commandEncoder.finish()]);
            await this.device.queue.onSubmittedWorkDone();
        } finally {
            this.destroy(numsBuf);
            this.destroy(ofsBuf);
        }
    }

    /**
     * Compute distance field using jump flood algorithm.
     * O(N^3 log(N)) compute
     * 
     * @param {VoxelGridGpu<u32>} inSeedVg Positive cells = 0-distance (seed) cells.
     * @param {VoxelGridGpu<f32>} outDistVg Distance field. Distance from nearest seed cell will be written.
     * @returns {Promise<void>}
     * @async
     */
    async distField(inSeedVg, outDistVg) {
        const grid = this.#checkGridCompat(inSeedVg, outDistVg);

        // xyz=seed, w=dist. w=-1 means invalid (no seed) data.
        const df = this.createLike(inSeedVg, "vec4f");
        await this.map("df_init", inSeedVg, df);

        // Jump flood
        let numPass = Math.ceil(Math.log2(Math.max(grid.numX, grid.numY, grid.numZ)));

        for (let pass = 0; pass < numPass; pass++) {
            const step = 2 ** (numPass - pass - 1);
            const commandEncoder = this.device.createCommandEncoder();
            const numsBuf = this.createUniformBuffer(32, (ptr) => {
                new Uint32Array(ptr, 0, 4).set([
                    grid.numX, grid.numY, grid.numZ, step,
                ]);
            });
            const ofsBuf = this.createUniformBuffer(32, (ptr) => {
                new Float32Array(ptr, 0, 4).set([
                    grid.ofs.x, grid.ofs.y, grid.ofs.z, grid.res,
                ]);
            });
            this.#dispatchKernel(commandEncoder, this.jumpFloodPipeline, [df.buffer], grid.numX * grid.numY * grid.numZ, numsBuf, ofsBuf);
            this.device.queue.submit([commandEncoder.finish()]);
            await this.device.queue.onSubmittedWorkDone();
            numsBuf.destroy();
            ofsBuf.destroy();
        }

        await this.map("df_to_dist", df, outDistVg);
        this.destroy(df);
    }

    /**
     * Throws error if ty is not allowed in map/map2 or grid types.
     * @param {string} ty 
     */
    static checkAllowedType(ty) {
        if (ty !== "u32" && ty !== "f32" && ty !== "vec3f" && ty !== "vec4f") {
            throw new Error("Invalid type: " + ty);
        }
    }

    /**
     * Returns on-memory size of type (that passes {@link #checkAllowedType}).
     * @param {string} ty 
     * @returns {number}
     */
    static sizeOfType(ty) {
        return {
            "u32": 4,
            "f32": 4,
            "vec3f": 16, // 16, not 12, because of alignment. https://www.w3.org/TR/WGSL/#alignment-and-size
            "vec4f": 16,
        }[ty];
    }

    /**
     * Throws error if grids are not compatible and returns common grid parameters.
     * @param {VoxelGridGpu} vg1 
     * @param {...VoxelGridGpu} vgs Additional grids to check compatibility with
     * @returns {{res: number, numX: number, numY: number, numZ: number, ofs: Vector3}} Common grid parameters
     */
    #checkGridCompat(vg1, ...vgs) {
        for (const grid2 of vgs) {
            if (vg1.numX !== grid2.numX || vg1.numY !== grid2.numY || vg1.numZ !== grid2.numZ) {
                throw new Error(`Grid size mismatch: ${vg1.numX}x${vg1.numY}x${vg1.numZ} vs ${grid2.numX}x${grid2.numY}x${grid2.numZ}`);
            }
            if (vg1.ofs.x !== grid2.ofs.x || vg1.ofs.y !== grid2.ofs.y || vg1.ofs.z !== grid2.ofs.z) {
                throw new Error(`Grid offset mismatch: (${vg1.ofs.x},${vg1.ofs.y},${vg1.ofs.z}) vs (${grid2.ofs.x},${grid2.ofs.y},${grid2.ofs.z})`);
            }
            if (vg1.res !== grid2.res) {
                throw new Error(`Grid resolution mismatch: ${vg1.res} vs ${grid2.res}`);
            }
        }
        return {
            res: vg1.res,
            numX: vg1.numX,
            numY: vg1.numY,
            numZ: vg1.numZ,
            ofs: vg1.ofs,
        };
    }

    /**
     * Create buffer for compute.
     * Supports: read/write from shader, bulk-copy from/to other buffer, very slow write from CPU
     * Does not support: bulk read to CPU
     * @param {number} size Size in bytes
     * @returns {GPUBuffer} Created buffer
     */
    createBuffer(size) {
        return this.device.createBuffer({
            label: "buf-storage",
            size: size,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
    }

    /**
     * Create uniform buffer & initialize with initFn.
     * @param {number} size Size in bytes
     * @param {Function} initFn Function to initialize buffer data, called with mapped ArrayBuffer
     * @returns {GPUBuffer} Created buffer (no longer mapped, directly usable)
     */
    createUniformBuffer(size, initFn) {
        const buf = this.device.createBuffer({
            label: "buf-uniform",
            size: size,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        initFn(buf.getMappedRange(0, size));
        buf.unmap();
        return buf;
    }

    /**
     * Create buffer for reading to CPU.
     * Supports: bulk-copy from other buffer, bulk read from CPU.
     * Does not support: shader read/write
     * @param {number} size Size in bytes
     * @returns {GPUBuffer} Created buffer
     */
    createBufferForCpuRead(size) {
        return this.device.createBuffer({
            label: "buf-for-cpu-read",
            size: size,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
    }

    /**
     * Create buffer for writing from CPU.
     * Supports: bulk-copy to other buffer, bulk write from CPU.
     * Does not support: shader read/write
     * @param {number} size Size in bytes
     * @returns {GPUBuffer} Created buffer
     */
    createBufferForCpuWrite(size) {
        return this.device.createBuffer({
            label: "buf-for-cpu-write",
            size: size,
            usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
        });
    }

    /**
     * Create a single pipeline.
     * @param {string} entryPoint Entry point name
     * @param {string[]} bindings Array of binding types ("storage" | "uniform")
     * @param {boolean} enableGridSnippet Whether shaderCode contains GridSnippet.
     * @param {string} shaderCode WGSL code
     * @param {number[]} uniformIds Additional uniform binding IDs
     * @returns {GPUComputePipeline} Created pipeline
     * @private
     */
    #createPipeline(entryPoint, bindings, enableGridSnippet, shaderCode, uniformIds = []) {
        const shaderModule = this.device.createShaderModule({ code: shaderCode, label: entryPoint });

        const bindEntries = bindings.map((type, i) => ({
            binding: i,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type }
        }));
        if (enableGridSnippet) {
            // 100,101 must match this.gridSnippet
            bindEntries.push({
                binding: 100,
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type: "uniform" }
            });
            bindEntries.push({
                binding: 101,
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type: "uniform" }
            });
        }
        for (const bindingId of uniformIds) {
            bindEntries.push({
                binding: bindingId,
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type: "uniform" }
            });
        }
        const bindGroupLayout = this.device.createBindGroupLayout({ entries: bindEntries, label: entryPoint });
        return this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
            compute: { module: shaderModule, entryPoint }
        });
    }

    /**
     * Dispatch kernel.
     * @param {GPUCommandEncoder} commandEncoder Command encoder
     * @param {GPUComputePipeline} pipeline Pipeline to use
     * @param {GPUBuffer[]} args Array of buffers to bind (assigned to binding 0, 1, 2, ...)
     * @param {number} numThreads Number of total threads (wanted kernel execs)
     * @param {GPUBuffer | null} numsBuf Buffer for nums (iff pipeline is created with enableGridSnippet)
     * @param {GPUBuffer | null} ofsBuf Buffer for ofs (iff pipeline is created with enableGridSnippet)
     * @param {[[number, GPUBuffer]]} additionalEntries Additional entries to bind (bindingId, buffer).
     * @private
     */
    #dispatchKernel(commandEncoder, pipeline, args, numThreads, numsBuf = null, ofsBuf = null, additionalEntries = []) {
        const entries = args.map((buf, i) => ({ binding: i, resource: { buffer: buf } }));
        if (numsBuf) {
            entries.push({ binding: 100, resource: { buffer: numsBuf } });
        }
        if (ofsBuf) {
            entries.push({ binding: 101, resource: { buffer: ofsBuf } });
        }
        for (const [bindingId, buf] of additionalEntries) {
            entries.push({ binding: bindingId, resource: { buffer: buf } });
        }
        const bindGroup = this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: entries,
        });

        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.dispatchWorkgroups(Math.ceil(numThreads / 128));
        passEncoder.end();
    }
}
