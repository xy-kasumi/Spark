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
    * @param {string} [type="u8"] Type of cell ("u32" | "f32")
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
     * @param {string} [type="u8"] Type of cell ("u32" | "f32")
     */
    constructor(kernels, res, numX, numY, numZ, ofs = new Vector3(), type = "u32") {
    }
}


export class GpuKernels {
    constructor(device) {
        this.device = device;
        this.#compileInit();
        this.#compileApplyCylinder();
        this.#compileApplyTransform();
        this.#compileComputeAABB();
        this.#compileGatherActive();
    }

    /**
     * Copy data from inBuf to outBuf. This can cross CPU/GPU boundary.
     *
     * @param {VoxelGrid | VoxelGridCpu} inBuf 
     * @param {VoxelGrid | VoxelGridCpu} outBuf 
     */
    async copy(inBuf, outBuf) {
    }

    /**
     * Destroy & free buffer.
     * @param {VoxelGrid} buf 
     */
    async destroy(buf) {
    }

    /**
     * 
     * @param {string} name 
     * @param {string} snippet 
     */
    async registerMapFn(name, snippet) {
    }

    /**
     * 
     * @param {string} name 
     * @param {string} snippet 
     */
    async registerMap2Fn(name, snippet) {
    }

    /**
     * 
     * @param {string} fnName 
     * @param {VoxelGrid} inBuf 
     * @param {VoxelGrid} outBuf 
     */
    async map(fnName, inBuf, outBuf=inBuf) {
    }

    /**
     * 
     * @param {string} fnName 
     * @param {VoxelGrid} inBuf1 
     * @param {VoxelGrid} inBuf2 
     * @param {VoxelGrid} outBuf 
     */
    async map2(fnName, inBuf1, inBuf2, outBuf=inBuf1) {
    }

    /**
     * 
     * @param {string} dir Unit vector representing axis to check.
     * @param {VoxelGrid} inBuf 
     * @param {"in" | "out" | "nearest"} boundary
     * @returns {{min: number, max: number}}
     */
    async boundOfAxis(dir, inBuf, boundary) {
    }

    /**
     * 
     * @param {Object} shape
     * @param {VoxelGrid} inBuf
     * @param {"in" | "out" | "nearest"} boundary
     * @returns {boolean} 
     */
    async any(shape, inBuf, boundary) {
    }

    /**
     * 
     * @param {Object} shape 
     * @param {VoxelGrid} inBuf 
     * @param {"in" | "out" | "nearest"} boundary 
     * @param {VoxelGrid} outBuf 
     */
    async fill(shape, inBuf, boundary, outBuf=inBuf) {
    }

    /**
     * Compute distance field using jump flood algorithm.
     * O(N^3 log(N)) compute
     * 
     * @param {VoxelGrid} inBuf Non-zero regions marks 0-distance cells.
     * @param {VoxelGrid} outBuf Distance field. Nearest distance from non-zero inBuf cells will be recorded.
     */
    async distField(inBuf, outBuf) {
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
            const nSeedPos = new THREE.Vector3();

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
                            nSeedPos.set(seedPosX.get(nx, ny, nz), seedPosY.get(nx, ny, nz), seedPosZ.get(nx, ny, nz));
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
    }

    // Create buffer for compute.
    // Supports: read/write from shader, bulk-copy from/to other buffer, very slow write from CPU
    // Does not support: bulk read to CPU
    createBuffer(size) {
        return this.device.createBuffer({
            size: size,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
    }

    // Create uniform buffer & initialize with initFn.
    // [in] size: number, bytes
    // initFn: (ptr: ArrayBuffer) -> (), ptr is passed in "mapped" state.
    // return: GpuBuffer (no longer mapped, directly usable)
    createUniformBuffer(size, initFn) {
        const buf = this.device.createBuffer({
            size: size,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        initFn(buf.getMappedRange(0, size));
        buf.unmap();
        return buf;
    }

    // Create buffer for reading to cpu.
    // Supports: bulk-copy from other buffer, bulk read from cpu.
    // Does not support: shader read/write
    createBufferForCpuRead(size) {
        return this.device.createBuffer({
            size: size,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
    }

    // Create a single pipeline.
    // [in] entryPoint: string, entry point name
    // [in] bindings: array of string, "storage" | "uniform"
    // [in] shaderCode: string, WGSL code
    #createPipeline(entryPoint, bindings, shaderCode) {
        const shaderModule = this.device.createShaderModule({ code: shaderCode });

        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: bindings.map((type, i) => ({
                binding: i,
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type }
            })),
        });

        return this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
            compute: { module: shaderModule, entryPoint }
        });
    }

    // Dispatch kernel.
    // [in] commandEncoder: GPUCommandEncoder
    // [in] pipeline: GPUComputePipeline
    // [in] args: array of GPUBuffer. Will be assigned to binding 0, 1, 2, ... automatically.
    // [in] numThreads: number of total threads (wanted kernel execs)
    #dispatchKernel(commandEncoder, pipeline, args, numThreads) {
        const bindGroup = this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: args.map((buf, i) => ({ binding: i, resource: { buffer: buf } }))
        });

        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.dispatchWorkgroups(Math.ceil(numThreads / 128));
        passEncoder.end();
    }

    #compileRadixPadding() {
        this.padForRadixSortPipeline = this.#createPipeline("pad_for_radix_sort", ["storage"], `
                @group(0) @binding(0) var<storage, read_write> arr_out: array<u32>;

                @compute @workgroup_size(128)
                fn pad_for_radix_sort(@builtin(global_invocation_id) gid: vec3<u32>) {
                    let ix = gid.x;
                    if (ix >= arrayLength(&arr_out)) {
                        return;
                    }
                    arr_out[ix] = 0xffffffff;
                }
            `
        );
    }

    async _readAllV4(buf) {
        const numVecs = buf.size / 16;
        const tempBuffer = this.createBufferForCpuRead(numVecs * 16);
        await this.device.queue.onSubmittedWorkDone();

        const commandEncoder = this.device.createCommandEncoder();
        commandEncoder.copyBufferToBuffer(buf, 0, tempBuffer, 0, numVecs * 16);
        this.device.queue.submit([commandEncoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();

        await tempBuffer.mapAsync(GPUMapMode.READ);
        const view = new Float32Array(tempBuffer.getMappedRange(0, numVecs * 16));
        const pts = [];
        for (let i = 0; i < numVecs; i++) {
            pts.push(new THREE.Vector4(
                view[i * 4 + 0],
                view[i * 4 + 1],
                view[i * 4 + 2],
                view[i * 4 + 3]
            ));
        }
        tempBuffer.unmap();
        return pts;
    }

    #compileInit() {
        this.initPipeline = this.#createPipeline("init", ["storage", "uniform"], `
                @group(0) @binding(0) var<storage, read_write> points: array<vec4f>;
                
                struct Params {
                    size: vec4f, // xyz: min point coordinates, w: step
                    dims: vec4u, // xyz: number of points in each axis, w: unused
                }
                @group(0) @binding(1) var<uniform> params: Params;

                fn rand1D(i: f32) -> f32 {
                    return fract(sin(i * 12.9898) * 43758.5453);
                }

                fn xs32(s: u32) -> u32 { var x=s; x^=x<<13; x^=x>>17; x^=x<<5; return x; }
                fn rand01(cnt: u32, key: u32) -> f32 {
                    return f32(xs32(cnt * key)) * (1.0 / 4294967296.0);
                }

                @compute @workgroup_size(128)
                fn init(@builtin(global_invocation_id) id: vec3u) {
                    let index = id.x;
                    if(index >= arrayLength(&points)) {
                        return;
                    }
                    
                    let z = index / (params.dims.x * params.dims.y);
                    let y = (index % (params.dims.x * params.dims.y)) / params.dims.x;
                    let x = index % params.dims.x;

                    let noise = vec3f(
                        rand01(u32(index), 0xca272690),
                        rand01(u32(index), 0xb8100b94),
                        rand01(u32(index), 0x13941583)) * 0.5;

                    let pos_local = 
                        params.size.xyz +
                        (vec3f(f32(x), f32(y), f32(z)) + noise) * params.size.w;
                    points[index] = vec4f(pos_local, 1);
                }
            `
        );
    }

    // Initialize point cloud.
    // [in] size: THREE.Vector3
    // [in] pointsPerMm: number
    // returns: buffer (vec4)
    async initBox(size, pointsPerMm) {
        const pointsPerAxis = size.clone().multiplyScalar(pointsPerMm).ceil();
        const numPoints = pointsPerAxis.x * pointsPerAxis.y * pointsPerAxis.z;
        const minPoint = size.clone().multiplyScalar(-0.5);

        const pointsBuf = this.createBuffer(numPoints * 16);
        const paramBuf = this.createUniformBuffer(32, (ptr) => {
            new Float32Array(ptr, 0, 4).set([
                minPoint.x, minPoint.y, minPoint.z, 1 / pointsPerMm,
            ]);
            new Uint32Array(ptr, 16, 4).set([
                pointsPerAxis.x, pointsPerAxis.y, pointsPerAxis.z, 0,
            ]);
        });

        const commandEncoder = this.device.createCommandEncoder();
        this.#dispatchKernel(commandEncoder, this.initPipeline, [pointsBuf, paramBuf], numPoints);
        this.device.queue.submit([commandEncoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();

        paramBuf.destroy();

        return pointsBuf;
    }

    #compileApplyCylinder() {
        this.applyCylinderPipeline = this.#createPipeline("apply_cylinder", ["storage", "storage", "uniform"], `
                @group(0) @binding(0) var<storage, read_write> ps_in: array<vec4f>;
                @group(0) @binding(1) var<storage, read_write> ps_out: array<vec4f>;
                @group(0) @binding(2) var<uniform> diameter: f32;

                @compute @workgroup_size(128)
                fn apply_cylinder(@builtin(global_invocation_id) gid: vec3u) {
                    let index = gid.x;
                    if (index >= arrayLength(&ps_in)) {
                        return;
                    }

                    let p = ps_in[index];
                    let p_radius = length(p.xy);
                    ps_out[index] = vec4(p.xyz, select(0.0, 1.0, p_radius <= diameter * 0.5 && p.w > 0.5));
                }
            `
        );
    }

    // Only keep points inside the cylinder (Z=main axis)
    // [in] psIn: array<vec4f>
    // [in] diameter: number
    // returns: array<vec4f> (same order & length as psIn, w is updated)
    async applyCylinder(psIn, diameter) {
        const numPoints = psIn.size / 16;
        const psOut = this.createBuffer(numPoints * 16);

        const paramBuf = this.createUniformBuffer(4, (ptr) => {
            new Float32Array(ptr).set([diameter]);
        });

        const commandEncoder = this.device.createCommandEncoder();
        this.#dispatchKernel(commandEncoder, this.applyCylinderPipeline, [psIn, psOut, paramBuf], numPoints);
        this.device.queue.submit([commandEncoder.finish()]);
        paramBuf.destroy();
        return psOut;
    }

    #compileApplyTransform() {
        this.applyTransformPipeline = this.#createPipeline("apply_transform", ["storage", "storage", "uniform"], `
                @group(0) @binding(0) var<storage, read_write> ps_in: array<vec4f>;
                @group(0) @binding(1) var<storage, read_write> ps_out: array<vec4f>;
                @group(0) @binding(2) var<uniform> transform: mat4x4f;

                @compute @workgroup_size(128)
                fn apply_transform(@builtin(global_invocation_id) id: vec3u) {
                    let index = id.x;
                    if (index >= arrayLength(&ps_in)) {
                        return;
                    }
                    
                    let p = ps_in[index];
                    let p_new = (transform * vec4f(p.xyz, 1)).xyz;
                    ps_out[index] = vec4f(p_new, p.w);
                }
            `
        );
    }

    // Initialize point cloud. In psIn and return value, w is 1 if alive, 0 if dead.
    // [in] psIn: array<vec4f>
    // [in] locToWorld: THREE.Matrix4
    // returns: array<vec4f> (same order & length as psIn)
    async applyTransform(psIn, locToWorld) {
        const numPoints = psIn.size / 16;
        const psOut = this.createBuffer(numPoints * 16);

        const matBuf = this.createUniformBuffer(64, (ptr) => {
            // col-major -> col-major (cf. https://threejs.org/docs/?q=Matrix#api/en/math/Matrix4.compose)
            new Float32Array(ptr).set(locToWorld.elements);
        });

        const commandEncoder = this.device.createCommandEncoder();
        this.#dispatchKernel(commandEncoder, this.applyTransformPipeline, [psIn, psOut, matBuf], numPoints);
        this.device.queue.submit([commandEncoder.finish()]);
        matBuf.destroy();
        return psOut;
    }

    #compileComputeAABB() {
        this.computeAABBPipeline = this.#createPipeline("reduce_aabb", ["storage", "storage", "storage", "storage"], `
                const wg_size = 128u;
                var<workgroup> wg_buffer_min: array<vec4f, wg_size>;
                var<workgroup> wg_buffer_max: array<vec4f, wg_size>;

                @group(0) @binding(0) var<storage, read_write> ps_in_min: array<vec4f>;
                @group(0) @binding(1) var<storage, read_write> ps_in_max: array<vec4f>;
                @group(0) @binding(2) var<storage, read_write> ps_out_min: array<vec4f>;
                @group(0) @binding(3) var<storage, read_write> ps_out_max: array<vec4f>;

                @compute @workgroup_size(wg_size)
                fn reduce_aabb(@builtin(global_invocation_id) gid_raw: vec3u, @builtin(local_invocation_index) lid: u32) {
                    let gid = gid_raw.x;

                    var p_min = vec3f(1e10);
                    var p_max = vec3f(-1e10);
                    if (gid < arrayLength(&ps_in_min)) {
                        let in_min = ps_in_min[gid];
                        let in_max = ps_in_max[gid];
                        if (in_min.w > 0.5) {
                            p_min = in_min.xyz;
                            p_max = in_max.xyz;
                        }
                    }
                    wg_buffer_min[lid] = vec4(p_min, 1);
                    wg_buffer_max[lid] = vec4(p_max, 1);

                    var stride = wg_size / 2;
                    while (stride > 0) {
                        workgroupBarrier();
                        if (lid < stride) {
                            wg_buffer_min[lid] = min(wg_buffer_min[lid], wg_buffer_min[lid + stride]);
                            wg_buffer_max[lid] = max(wg_buffer_max[lid], wg_buffer_max[lid + stride]);
                        }
                        stride /= 2;
                    }
                    if (lid == 0) {
                        let ix_group = gid / wg_size;
                        ps_out_min[ix_group] = vec4(wg_buffer_min[0].xyz, 1);
                        ps_out_max[ix_group] = vec4(wg_buffer_max[0].xyz, 1);
                    }
                }
            `
        );
    }

    // Initialize point cloud. In psIn and return value, w is 1 if alive, 0 if dead.
    // [in] ps: array<vec4f>
    // returns: {min: THREE.Vector3, max: THREE.Vector3}
    async computeAABB(ps) {
        const numPoints = ps.size / 16;

        const temp0Min = this.createBuffer(numPoints * 16);
        const temp0Max = this.createBuffer(numPoints * 16);
        const temp1Min = this.createBuffer(numPoints * 16);
        const temp1Max = this.createBuffer(numPoints * 16);
        const readBuf = this.createBufferForCpuRead(16 * 2);

        const commandEncoder = this.device.createCommandEncoder();

        commandEncoder.copyBufferToBuffer(ps, 0, temp0Min, 0, numPoints * 16);
        commandEncoder.copyBufferToBuffer(ps, 0, temp0Max, 0, numPoints * 16);

        let currentNumPoints = numPoints;
        let mode0to1 = true;
        while (currentNumPoints > 1) {
            this.#dispatchKernel(
                commandEncoder,
                this.computeAABBPipeline,
                [
                    mode0to1 ? temp0Min : temp1Min,
                    mode0to1 ? temp0Max : temp1Max,
                    mode0to1 ? temp1Min : temp0Min,
                    mode0to1 ? temp1Max : temp0Max
                ],
                currentNumPoints
            );

            mode0to1 = !mode0to1;
            currentNumPoints = Math.ceil(currentNumPoints / 128);
        }

        // store min to [0, 16), max to [16, 32) in readBuf
        commandEncoder.copyBufferToBuffer(mode0to1 ? temp0Min : temp1Min, 0, readBuf, 0, 16);
        commandEncoder.copyBufferToBuffer(mode0to1 ? temp0Max : temp1Max, 0, readBuf, 16, 16);

        this.device.queue.submit([commandEncoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();

        await readBuf.mapAsync(GPUMapMode.READ);
        const min = new Float32Array(readBuf.getMappedRange(0, 16));
        const max = new Float32Array(readBuf.getMappedRange(16, 16));
        const aabb = {
            min: new THREE.Vector3(min[0], min[1], min[2]),
            max: new THREE.Vector3(max[0], max[1], max[2]),
        }
        readBuf.unmap();

        temp0Min.destroy();
        temp0Max.destroy();
        temp1Min.destroy();
        temp1Max.destroy();
        readBuf.destroy();

        return aabb;
    }

    #compileGatherActive() {
        this.gatherActivePipeline = this.#createPipeline("gather_active", ["storage", "storage", "storage"], `
                @group(0) @binding(0) var<storage, read_write> psIn: array<vec4<f32>>;
                @group(0) @binding(1) var<storage, read_write> psOut: array<vec4<f32>>;
                @group(0) @binding(2) var<storage, read_write> counter: atomic<u32>;

                @compute @workgroup_size(128)
                fn gather_active(@builtin(global_invocation_id) gid: vec3<u32>) {
                    let i = gid.x;
                    if (i >= arrayLength(&psIn)) {
                        return;
                    }

                    let p = psIn[i];
                    if (p.w == 1.0) {
                        let outIndex = atomicAdd(&counter, 1u);
                        psOut[outIndex] = p;
                    }
                }
            `
        );
    }

    // Gather active points from psIn.
    // [in] psIn: array<vec4f>
    // returns: new buffer
    async gatherActive(psIn) {
        const numPoints = psIn.size / 16;

        const tempBuf = this.createBuffer(numPoints * 16);
        const countBuf = this.createBuffer(4);
        const countBufReading = this.createBufferForCpuRead(4);

        this.device.queue.writeBuffer(countBuf, 0, new Uint32Array([0]));

        const commandEncoder = this.device.createCommandEncoder();
        this.#dispatchKernel(commandEncoder, this.gatherActivePipeline, [psIn, tempBuf, countBuf], numPoints);
        commandEncoder.copyBufferToBuffer(countBuf, 0, countBufReading, 0, 4);
        this.device.queue.submit([commandEncoder.finish()]);

        await countBufReading.mapAsync(GPUMapMode.READ);
        const count = new Uint32Array(countBufReading.getMappedRange(0, 4))[0];
        countBufReading.unmap();

        // copy to new smaller buffer
        const resultBuffer = this.createBuffer(count * 16);
        {
            const commandEncoder = this.device.createCommandEncoder();
            commandEncoder.copyBufferToBuffer(tempBuf, 0, resultBuffer, 0, count * 16);
            this.device.queue.submit([commandEncoder.finish()]);
            await this.device.queue.onSubmittedWorkDone();
        }
        tempBuf.destroy();
        countBuf.destroy();
        countBufReading.destroy();
        return resultBuffer;
    }

    static #gridSnippet = `
        struct AABBGrid {
            min_unit: vec4f, // xyz: min coordinate, w: cell unit size
            dims: vec4u,
        }
        
        fn cell_ix3(p: vec3f, grid: AABBGrid) -> vec3u {
            return vec3u(floor((p - grid.min_unit.xyz) / grid.min_unit.w));
        }

        fn cell_3to1(cix3: vec3u, grid: AABBGrid) -> u32 {
            return cix3.x + cix3.y * grid.dims.x + cix3.z * grid.dims.x * grid.dims.y;
        }

        fn cell_ix(p: vec3f, grid: AABBGrid) -> u32 {
            let cix3 = cell_ix3(p, grid);
            return cell_3to1(cix3, grid);
        }
    `;
}
