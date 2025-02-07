/**
 * WebGPU-accelerated voxel operations and SDF (signed distance function) based queries.
 * 
 * See https://iquilezles.org/articles/distfunctions/ for nice introduction to SDF.
 */
import { Vector3, Vector4 } from 'three';

////////////////////////////////////////////////////////////////////////////////
// CPU code
// These are written with simplicity & flexibility, to serve as test reference
// and quick prototype / debug tool.

/**
 * @param {Vector3} p Start point
 * @param {Vector3} n Direction (the cylinder extends infinitely towards n+ direction)
 * @param {number} r Radius
 * @param {number} h Height
 * @returns {Object} Shape
 */
export const createCylinderShape = (p, n, r, h) => {
    if (n.length() !== 1) {
        throw "Cylinder direction not normalized";
    }
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
    if (n.length() !== 1) {
        throw "ELH direction not normalized";
    }
    if (q.clone().sub(p).dot(n) !== 0) {
        throw "Invalid extrusion normal";
    }
    if (q.distanceTo(p) < 0) {
        throw "Invalid p-q pair";
    }
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
    if (halfVec0.dot(halfVec1) !== 0 || halfVec0.dot(halfVec2) !== 0 || halfVec1.dot(halfVec2) !== 0) {
        throw "Half vectors must be perpendicular to each other";
    }
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
const createSdfCylinder = (p, n, r, h) => {
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
const createSdfElh = (p, q, n, r, h) => {
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
const createSdfBox = (center, halfVec0, halfVec1, halfVec2) => {
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
    /**
    * Create CPU-backed voxel grid.
    * @param {number} res Voxel resolution
    * @param {number} numX Grid dimension X
    * @param {number} numY Grid dimension Y
    * @param {number} numZ Grid dimension Z
    * @param {Vector3} [ofs=new Vector3()] Voxel grid offset (local to world)
    * @param {"u32" | "f32"} type Cell type
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
     * Set all cells to given value
     * @param {number} val Value to fill
     * @returns {VoxelGridCpu} this
     */
    fill(val) {
        this.data.fill(val);
        return this;
    }

    /**
     * Apply pred to all cells.
     */
    map(pred) {
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
     * @param {(any, Vector3) => boolean} pred Predicate function (val, pos) => result
     * @returns {number} Count of cells that satisfy predicate
     */
    countIf(pred) {
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
     * Calculate volume of positive cells
     * @returns {number} Volume in cubic units
     */
    volume() {
        return this.countIf((val) => val > 0) * this.res ** 3;
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


////////////////////////////////////////////////////////////////////////////////
// GPU code


/**
 * Uniform variable list for {@link uberSdfSnippet}.
 */
export const uberSdfUniformDefs = {
    "_sd_ty": "u32",
    "_sd_p0": "vec3f",
    "_sd_p1": "vec3f",
    "_sd_p2": "vec3f",
    "_sd_p3": "vec3f",
};

/**
 * Generates SDF uniform variable dictionary for given shape.
 * @param {Object} shape 
 * @returns {Object} Uniform variable dictionary
 */
export const uberSdfUniformVars = (shape) => {
    if (shape.type === "cylinder") {
        return {
            _sd_ty: 0,
            _sd_p0: shape.p,
            _sd_p1: shape.n,
            _sd_p2: new Vector3(shape.r, shape.h, 0),
            _sd_p3: new Vector3(),
        };
    } else if (shape.type === "ELH") {
        return {
            _sd_ty: 1,
            _sd_p0: shape.p,
            _sd_p1: shape.q,
            _sd_p2: shape.n,
            _sd_p3: new Vector3(shape.r, shape.h, 0),
        };
    } else if (shape.type === "box") {
        return {
            _sd_ty: 2,
            _sd_p0: shape.center,
            _sd_p1: shape.halfVec0,
            _sd_p2: shape.halfVec1,
            _sd_p3: shape.halfVec2,
        };
    } else {
        throw new Error(`Unsupported shape type: ${shape.type}`);
    }
};

/**
 * Generates SDF snippet that can handle all shapes.
 */
export const uberSdfSnippet = (inVar, outVar) => {
    return `
    {
        if (_sd_ty == 0) {
            let _sd_p = _sd_p0;
            let _sd_n = _sd_p1;
            let _sd_r = _sd_p2.x;
            let _sd_h = _sd_p2.y;
            ${wgslSdfCylinderSnippet(inVar, outVar)}
        } else if (_sd_ty == 1) {
            let _sd_p = _sd_p0;
            let _sd_q = _sd_p1;
            let _sd_n = _sd_p2;
            let _sd_r = _sd_p3.x;
            let _sd_h = _sd_p3.y;
            ${wgslSdfElhSnippet(inVar, outVar)}
        } else if (_sd_ty == 2) {
            let _sd_c = _sd_p0;
            let _sd_hv0 = _sd_p1;
            let _sd_hv1 = _sd_p2;
            let _sd_hv2 = _sd_p3;
            ${wgslSdfBoxSnippet(inVar, outVar)}
        }
    }
    `;
};

// The snippet assumes _sd_p, _sd_n, _sd_r, _sd_h are declared as uniform variables.
const wgslSdfCylinderSnippet = (inVar, outVar) => {
    if (inVar.startsWith("_sd_") || outVar.startsWith("_sd_")) {
        throw "User variables cannot start with _sd_";
    }
    return `
        {
            let dx = ${inVar} - _sd_p;
            // decompose into 1D + 2D
            let dx1 = dot(dx, _sd_n);
            let dx2 = dx - _sd_n * dx1;
            // 1D distance from interval [0, h]
            let d1 = abs(dx1 - _sd_h * 0.5) - _sd_h * 0.5;
            // 2D distance from a circle r.
            let d2 = length(dx2) - _sd_r;
            // Combine 1D + 2D distances.
            ${outVar} = min(max(d1, d2), 0) + length(max(vec2f(0), vec2f(d1, d2)));
        }
    `;
};

// The snippet assumes _sd_p, _sd_q, _sd_n, _sd_r, _sd_h are declared as uniform variables.
const wgslSdfElhSnippet = (inVar, outVar) => {
    if (inVar.startsWith("_sd_") || outVar.startsWith("_sd_")) {
        throw "User variables cannot start with _sd_";
    }
    return `
        {
            let dq = _sd_q - _sd_p;
            let dqLenSq = dot(dq, dq);
            let dx = ${inVar} - _sd_p;
            // decompose into 2D + 1D
            let dx1 = dot(dx, _sd_n);
            let dx2 = dx - _sd_n * dx1;
            // 1D distance from interval [0, h]
            let d1 = abs(dx1 - _sd_h * 0.5) - _sd_h * 0.5;
            // 2D distance from long hole (0,dq,r)
            let t = clamp(dot(dx2, dq) / dqLenSq, 0, 1); // limit to line segment (between p & q)
            let d2 = distance(dx2, dq * t) - _sd_r;
            // Combine 1D + 2D distances.
            ${outVar} = min(max(d1, d2), 0) + length(max(vec2f(0), vec2f(d1, d2)));
        }
    `;
};

// The snippet assumes _sd_c, _sd_hv0, _sd_hv1, _sd_hv2 are declared as uniform variables.
const wgslSdfBoxSnippet = (inVar, outVar) => {
    if (inVar.startsWith("_sd_") || outVar.startsWith("_sd_")) {
        throw "User variables cannot start with _sd_";
    }
    return `
        {
            let dx = ${inVar} - _sd_c;
            var dp = abs(vec3f(
                dot(dx, normalize(_sd_hv0)),
                dot(dx, normalize(_sd_hv1)),
                dot(dx, normalize(_sd_hv2))));
            dp -= vec3f(length(_sd_hv0), length(_sd_hv1), length(_sd_hv2));

            let d_in = min(0, max(dp.x, max(dp.y, dp.z)));
            let d_out = length(max(vec3f(0), dp));
            ${outVar} = d_in + d_out;
        }
    `;
};


/**
 * GPU-backed voxel grid.
 * Most of {@link GpuKernels} methods only support VoxelGrid.
 * 
 * voxel at (ix, iy, iz):
 * - occupies volume: [ofs + ix * res, ofs + (ix + 1) * res)
 * - has center: ofs + (ix + 0.5) * res
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

/**
 * Represents uniform variable definition of a single GPU Pipeline.
 * This should be used with {@link GpuKernels}.
 */
class PipelineUniformDef {
    static BINDING_ID_BEGIN = 100;

    /**
     * @param {Object} defs {varName: type} Uniform variable defintions (can change for each invocation).
     */
    constructor(defs) {
        let uniformBindingId = PipelineUniformDef.BINDING_ID_BEGIN;
        const shaderLines = [];
        this.bindings = {};
        for (const [varName, type] of Object.entries(defs)) {
            GpuKernels.checkAllowedType(type);
            shaderLines.push(`@group(0) @binding(${uniformBindingId}) var<uniform> ${varName}: ${type};`);
            this.bindings[varName] = {
                bindingId: uniformBindingId,
                type: type,
            };
            uniformBindingId++;
        }
        this.shader = shaderLines.join("\n") + "\n";
    }

    /**
     * Get multi-line shader uniform variable declarations.
     * @returns {string} Multi-line shader uniform variable declarations. (e.g. "@group(0) @binding(200) var<uniform> dir: vec3f;\n ...")
     */
    shaderVars() {
        return this.shader;
    }

    /**
     * Get uniform binding IDs. (order might not match what's given to constructor)
     * @returns {number[]} Uniform binding IDs.
     */
    uniformBindingIds() {
        return Object.values(this.bindings).map(({ bindingId }) => bindingId);
    }

    /**
     * Check runtime inputs can be handled correctly by this pipeline uniform definition.
     * @param {Object} vars {varName: value}
     * @throws {Error} If any input is invalid.
     */
    checkInput(vars) {
        const unknownVars = new Set(Object.keys(vars)).difference(new Set(Object.keys(this.bindings)));
        if (unknownVars.size > 0) {
            console.warn("Unknown uniform value provided: ", unknownVars);
        }
        for (const [varName, { type }] of Object.entries(this.bindings)) {
            if (vars[varName] === undefined) {
                throw new Error(`Required uniform variable "${varName}" not provided`);
            }
            const val = vars[varName];
            switch (type) {
                case "vec4f":
                case "vec4u":
                    if (this.extractArrayLikeOrVector(4, val) === null) {
                        throw new Error(`Uniform variable "${varName}: ${type}" must be a Vector4 or array of 4 numbers`);
                    }
                    break;
                case "vec3f":
                case "vec3u":
                    if (this.extractArrayLikeOrVector(3, val) === null) {
                        throw new Error(`Uniform variable "${varName}: ${type}" must be a Vector3 or array of 3 numbers`);
                    }
                    break;
                case "f32":
                case "u32":
                    if (typeof val !== "number") {
                        throw new Error(`Uniform variable "${varName}: ${type}" must be a number`);
                    }
                    break;
                default:
                    throw new Error(`Unsupported uniform variable type: ${type}`);
            }
        }
    }

    /**
     * Extract numbers from an array-like or vector with expectedLen elements.
     * If invalid, return null. Doesn't return partial results.
     * 
     * @param {number} expectedLen 
     * @param {any} val 
     * @returns {number[] | null} Array of numbers or null if invalid.
     */
    extractArrayLikeOrVector(expectedLen, val) {
        if (val.length === expectedLen) {
            const nums = [];
            for (let i = 0; i < expectedLen; i++) {
                if (typeof val[i] !== "number") {
                    return null;
                }
                nums.push(val[i]);
            }
            return nums;
        }
        if (expectedLen === 3 && val instanceof Vector3) {
            return [val.x, val.y, val.z];
        }
        if (expectedLen === 4 && val instanceof Vector4) {
            return [val.x, val.y, val.z, val.w];
        }
        return null;
    }

    /**
     * Return uniform buffers by setting given values.
     * Caller can also call {@link checkInput} first, to check for input errors before any other GPU processing.
     * Caller MUST NOT destroy buffer, as it uses shared internal buffer.
     * As createBuffers relies on {@link GPUQueue.writeBuffer} to copy data to GPU,
     * so if caller is using multiple dispatches in a single {@link GPUCommandEncoder},
     * it must provide unique uniBufIx for each dispatch.
     * 
     * @example
     * // Bad Example
     * const cme = device.createCommandEncoder();
     * const bind1 = pipeline.createBuffers(kernels, vars1);
     * cme.dispatch(..., bind1); // this dispatch will see vars2, not vars1.
     * const bind2 = pipeline.createBuffers(kernels, vars2);
     * cme.dispatch(..., bind2);
     * queue.submit([cme.finish()]);
     * 
     * // Bad Example, as seen by GPU
     * const bind1 = pipeline.createBuffers(kernels, vars1);
     * const bind2 = pipeline.createBuffers(kernels, vars2);
     * const cme = device.createCommandEncoder();
     * cme.dispatch(..., bind1);
     * cme.dispatch(..., bind2);
     * queue.submit([cme.finish()]);
     * 
     * // Good Example
     * const cme = device.createCommandEncoder();
     * const bind1 = pipeline.createBuffers(kernels, vars1, 0);
     * cme.dispatch(..., bind1);
     * const bind2 = pipeline.createBuffers(kernels, vars2, 1);
     * cme.dispatch(..., bind2);
     * queue.submit([cme.finish()]);
     * 
     * @param {GpuKernels} kernels 
     * @param {Object} vars {varName: value}
     * @param {number} uniBufIx Index of the uniform buffer to use. (Needed when doing multiple dispatches in single CommandBuffer)
     * @throws {Error} If any input is invalid.
     * @returns {[number, GPUBuffer, number, number][]} Array of [bindingId, buffer, offset, size]
     */
    getUniformBufs(kernels, vars, uniBufIx = 0) {
        const maxNumUniBuf = 10;
        const maxNumVars = 16;
        const entrySize = Math.max(16, kernels.device.limits.minUniformBufferOffsetAlignment);
        if (!kernels.sharedUniBuffer) {
            kernels.sharedUniBuffer = [];
            for (let i = 0; i < maxNumUniBuf; i++) {
                kernels.sharedUniBuffer.push(kernels.createUniformBufferNonMapped(entrySize * maxNumVars));
            }
        }

        this.checkInput(vars);

        if (Object.entries(this.bindings).length > maxNumVars) {
            throw new Error("Too many uniform variables");
        }
        if (uniBufIx >= maxNumUniBuf) {
            throw new Error("Too many uniform buffers at the same time");
        }

        const binds = [];
        const uniBuf = kernels.sharedUniBuffer[uniBufIx];
        // Writing everything to CPU and then single writeBuffer() is faster than multiple writeBuffer() calls,
        // despite bigger total copy size.
        const cpuBuf = new ArrayBuffer(entrySize * Object.entries(this.bindings).length);
        let ix = 0;
        for (const [varName, binding] of Object.entries(this.bindings)) {
            const { bindingId, type } = binding;
            const val = vars[varName];
            const entryOffset = entrySize * ix;

            if (type === "vec4f") {
                const nums = this.extractArrayLikeOrVector(4, val);
                new Float32Array(cpuBuf, entryOffset, 4).set(nums);
            } else if (type === "vec3f") {
                const nums = this.extractArrayLikeOrVector(3, val);
                new Float32Array(cpuBuf, entryOffset, 3).set(nums);
            } else if (type === "vec4u") {
                const nums = this.extractArrayLikeOrVector(4, val);
                new Uint32Array(cpuBuf, entryOffset, 4).set(nums);
            } else if (type === "vec3u") {
                const nums = this.extractArrayLikeOrVector(3, val);
                new Uint32Array(cpuBuf, entryOffset, 3).set(nums);
            } else if (type === "f32") {
                new Float32Array(cpuBuf, entryOffset, 1).set([val]);
            } else if (type === "u32") {
                new Uint32Array(cpuBuf, entryOffset, 1).set([val]);
            }
            binds.push([bindingId, null, entryOffset, entrySize]);
            ix++;
        }
        kernels.device.queue.writeBuffer(uniBuf, 0, cpuBuf, 0, cpuBuf.byteLength);
        for (const bind of binds) {
            bind[1] = uniBuf;
        }
        return binds;
    }
}


/**
 * GPU utilities.
 * Consisits of two layers
 * - 1D array part: no notion of geometry, just parallel data operation & wrappers.
 * - 3D voxel part: 1D array part + 3D geometry utils.
 */
export class GpuKernels {
    constructor(device) {
        this.device = device;
        this.wgSize = 128;
        this.mapPipelines = {};
        this.map2Pipelines = {};
        this.reducePipelines = {};
        this.perf = {};

        this.#initGridUtils();
    }

    /**
     * Utility to measure average time-peformance of many invocations.
     * returns end-mark function.
     * @param {string} name 
     * @returns {Function}
     */
    perfBegin(name) {
        const t0 = performance.now();
        const end = () => {
            if (!this.perf[name]) {
                this.perf[name] = {
                    time_ms_accum: 0,
                    time_ms_min: Infinity,
                    time_ms_max: 0,
                    n: 0,
                };
            }
            const time_ms = performance.now() - t0;
            const p = this.perf[name];
            p.time_ms_accum += time_ms;
            p.time_ms_min = Math.min(p.time_ms_min, time_ms);
            p.time_ms_max = Math.max(p.time_ms_max, time_ms);
            p.n++;
            if (p.n % 100 === 0) {
                console.log(`${name}: avg=${(p.time_ms_accum / p.n).toFixed(2)}ms (N=${p.n} min=${p.time_ms_min.toFixed(2)}ms max=${p.time_ms_max.toFixed(2)}ms)`);
            }
        };
        return {
            end: end
        };
    }

    /**
     * Copy data from inBuf to outBuf. This can cross CPU/GPU boundary.
     * Normally, size of inBuf and outBuf must match.
     * But if size is specified, size can differ as long as they're both same or larger than size.
     * 
     * @param {ArrayBuffer | GPUBuffer} inBuf
     * @param {ArrayBuffer | GPUBuffer} outBuf
     * @param {number} [copySize] Size of data to copy.
     * @returns {Promise<void>}
     * @async
     */
    async copyBuffer(inBuf, outBuf, copySize = null) {
        if (inBuf === outBuf) {
            return;
        }
        const inIsCpu = inBuf instanceof ArrayBuffer;
        const outIsCpu = outBuf instanceof ArrayBuffer;
        const inSize = inIsCpu ? inBuf.byteLength : inBuf.size;
        const outSize = outIsCpu ? outBuf.byteLength : outBuf.size;
        if (copySize === null) {
            if (inSize !== outSize) {
                throw new Error(`Buffer size mismatch: ${inSize} !== ${outSize}`);
            }
            copySize = inSize;
        } else if (inSize < copySize || outSize < copySize) {
            throw new Error(`Buffer is smaller than copySize: ${inSize} < ${copySize} || ${outSize} < ${copySize}`);
        }

        if (inIsCpu && outIsCpu) {
            // CPU->CPU: just clone
            new Uint8Array(outBuf, 0, copySize).set(new Uint8Array(inBuf, 0, copySize));
        } else if (inIsCpu && !outIsCpu) {
            // CPU->GPU: direct API.
            this.device.queue.writeBuffer(outBuf, 0, inBuf, 0, copySize);
        } else if (!inIsCpu && outIsCpu) {
            // GPU->CPU: via cpu-read buffer
            const tempBuf = this.createBufferForCpuRead(copySize);
            const commandEncoder = this.device.createCommandEncoder();
            commandEncoder.copyBufferToBuffer(inBuf, 0, tempBuf, 0, copySize);
            this.device.queue.submit([commandEncoder.finish()]);

            await tempBuf.mapAsync(GPUMapMode.READ);
            new Uint8Array(outBuf, 0, copySize).set(new Uint8Array(tempBuf.getMappedRange(0, copySize)));
            tempBuf.unmap();
            tempBuf.destroy();
        } else {
            // GPU->GPU: direct copy
            const commandEncoder = this.device.createCommandEncoder();
            commandEncoder.copyBufferToBuffer(inBuf, 0, outBuf, 0, copySize);
            this.device.queue.submit([commandEncoder.finish()]);
        }
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

        Object.assign(uniforms, this.#gridUniformDefs());

        const uniformDef = new PipelineUniformDef(uniforms);

        const code = `
            @group(0) @binding(0) var<storage, read_write> vs_in: array<${inType}>;
            @group(0) @binding(1) var<storage, read_write> vs_out: array<${outType}>;
            ${uniformDef.shaderVars()}

            ${this.#gridFns()}

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
        const pipeline = this.#createPipeline(`map_${name}`, 2, code, uniformDef);
        this.mapPipelines[name] = { pipeline, uniformDef, inType, outType };
    }

    /**
     * Register WGSL expression snippet for use in {@link map2}.
     * 
     * @param {string} name (not shared with registerMapFn)
     * @param {"u32" | "f32"} inType1 Type of input voxel
     * @param {"u32" | "f32"} inType2 Type of input voxel
     * @param {"u32" | "f32"} outType Type of output voxel
     * @param {string} snippet (multi-line allowed)
     * @param {Object} uniforms Uniform variable defintions (can change for each invocation) {varName: type}
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
    registerMap2Fn(name, inType1, inType2, outType, snippet, uniforms = {}) {
        if (this.map2Pipelines[name]) {
            throw new Error(`Map2 fn "${name}" already registered`);
        }
        GpuKernels.checkAllowedType(inType1);
        GpuKernels.checkAllowedType(inType2);
        GpuKernels.checkAllowedType(outType);

        Object.assign(uniforms, this.#gridUniformDefs());
        const uniformDef = new PipelineUniformDef(uniforms);

        const pipeline = this.#createPipeline(`map2_${name}`, 3, `
            @group(0) @binding(0) var<storage, read_write> vs_in1: array<${inType1}>;
            @group(0) @binding(1) var<storage, read_write> vs_in2: array<${inType2}>;
            @group(0) @binding(2) var<storage, read_write> vs_out: array<${outType}>;
            ${uniformDef.shaderVars()}

            ${this.#gridFns()}

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
        `, uniformDef);
        this.map2Pipelines[name] = { pipeline, uniformDef, inType1, inType2, outType };
    }

    /**
     * Register WGSL snippet for use in {@link reduce}.
     * 
     * @param {string} name 
     * @param {string} valType WGSL type signature of value type
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
        GpuKernels.checkAllowedType(valType);
        if (valType !== "u32" && valType !== "f32") {
            throw new Error(`Reduce fn "${name}": valType must be "u32" or "f32"`);
        }

        const uniforms = { num_active: "u32" };
        const uniformDef = new PipelineUniformDef(uniforms);

        const pipeline = this.#createPipeline(`reduce_${name}`, 2, `
            var<workgroup> wg_buffer_accum: array<${valType}, ${this.wgSize}>;

            @group(0) @binding(0) var<storage, read_write> vs_in: array<${valType}>;
            @group(0) @binding(1) var<storage, read_write> vs_out: array<${valType}>;
            ${uniformDef.shaderVars()}

            @compute @workgroup_size(${this.wgSize})
            fn reduce_${name}(@builtin(global_invocation_id) gid_raw: vec3u, @builtin(local_invocation_index) lid: u32) {
                let gid = gid_raw.x;

                var accum = ${initVal};
                if (gid < num_active) {
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
        `, uniformDef);
        this.reducePipelines[name] = { pipeline, valType, uniformDef };
    }

    /**
     * Run 1-input 1-output map.
     * @param {string} fnName 
     * @param {VoxelGridGpu} inVg 
     * @param {VoxelGridGpu} outVg
     * @param {Object} uniforms Uniform variable values.
     */
    map(fnName, inVg, outVg, uniforms = {}) {
        if (inVg === outVg) {
            throw new Error("inVg and outVg must be different");
        }
        const grid = this.#checkGridCompat(inVg, outVg);
        uniforms = Object.assign({}, uniforms, this.#gridUniformVars(grid));

        if (!this.mapPipelines[fnName]) {
            throw new Error(`Map fn "${fnName}" not registered`);
        }
        const { pipeline, uniformDef, inType, outType } = this.mapPipelines[fnName];
        if (inVg.type !== inType || outVg.type !== outType) {
            throw new Error(`Map fn "${fnName}" type mismatch; expected vi:${inType}, vo:${outType}, got vi:${inVg.type}, vo:${outVg.type}`);
        }
        uniformDef.checkInput(uniforms);

        const commandEncoder = this.device.createCommandEncoder();
        this.#dispatchKernel(commandEncoder, pipeline, [inVg.buffer, outVg.buffer], grid.numX * grid.numY * grid.numZ, uniformDef.getUniformBufs(this, uniforms));
        this.device.queue.submit([commandEncoder.finish()]);
    }

    /**
     * Run 2-input 1-output map. (aka zip)
     * @param {string} fnName 
     * @param {VoxelGridGpu} inVg1 
     * @param {VoxelGridGpu} inVg2 
     * @param {VoxelGridGpu} outVg 
     * @param {Object} uniforms Uniform variable values.
     */
    map2(fnName, inVg1, inVg2, outVg = inVg1, uniforms = {}) {
        if (inVg1 === outVg || inVg2 === outVg) {
            throw new Error("inVg1 or inVg2 must be different from outVg");
        }
        const grid = this.#checkGridCompat(inVg1, inVg2, outVg);
        uniforms = Object.assign({}, uniforms, this.#gridUniformVars(grid));

        if (!this.map2Pipelines[fnName]) {
            throw new Error(`Map2 fn "${fnName}" not registered`);
        }
        const { pipeline, uniformDef, inType1, inType2, outType } = this.map2Pipelines[fnName];
        if (inVg1.type !== inType1 || inVg2.type !== inType2 || outVg.type !== outType) {
            throw new Error(`Map2 fn "${fnName}" type mismatch; expected vi1:${inType1}, vi2:${inType2}, vo:${outType}, got vi1:${inVg1.type}, vi2:${inVg2.type}, vo:${outVg.type}`);
        }

        const commandEncoder = this.device.createCommandEncoder();
        this.#dispatchKernel(commandEncoder, pipeline, [inVg1.buffer, inVg2.buffer, outVg.buffer], grid.numX * grid.numY * grid.numZ, uniformDef.getUniformBufs(this, uniforms));
        this.device.queue.submit([commandEncoder.finish()]);
    }

    /**
     * Run reduction and store result to specfied location of the buffer.
     * 
     * @param {string} fnName Function registered in {@link registerReduceFn}.
     * @param {VoxelGridGpu} inVg 
     * @param {GPUBuffer} resultBuf Buffer to store result.
     * @param {number} resultBufOfs Result (4byte) is stored into [offset, offset+4) of resultBuf.
     * @param {GPUCommandEncoder} cme Optional external command encoder to use (if supplied, caller must call .submit()).
     * @param {number} uniBufIxBegin Index of begin of uniform buffer bindings, when cme !== null.
     */
    reduceRaw(fnName, inVg, resultBuf, resultBufOfs, cme = null, uniBufIxBegin = 0) {
        if (!this.reducePipelines[fnName]) {
            throw new Error(`Reduce fn "${fnName}" not registered`);
        }
        const { pipeline, valType, uniformDef } = this.reducePipelines[fnName];
        if (inVg.type !== valType) {
            throw new Error(`Reduce fn "${fnName}" type mismatch; expected ${valType}, got ${inVg.type}`);
        }

        // Dispatch like the following to minimize copy.
        // inVg -(reduce)-> buf0 -(reduce)-> buf1 -(reduce)-> buf0 -> ...
        const multOf4 = (n) => {
            return Math.ceil(n / 4) * 4;
        };
        const bufSize = multOf4(Math.ceil(inVg.buffer.size / this.wgSize));
        if (!this.tempBufsCache) {
            this.tempBufsCache = {};
        }
        const cacheKey = `${bufSize}`;
        if (!this.tempBufsCache[cacheKey]) {
            this.tempBufsCache[cacheKey] = [
                this.createBuffer(bufSize),
                this.createBuffer(bufSize),
            ];
        }
        const tempBufs = this.tempBufsCache[cacheKey];
        let activeBufIx = -1; // -1 means inVg is active, 0 and 1 means tempBufs are active.
        const getBuf = (ix) => {
            return ix === -1 ? inVg.buffer : tempBufs[ix];
        };
        const nextIx = (ix) => {
            return ix === -1 ? 0 : 1 - ix;
        };

        const commandEncoder = cme ?? this.device.createCommandEncoder();
        let numElems = inVg.numX * inVg.numY * inVg.numZ;
        let uniBufIx = uniBufIxBegin;
        while (numElems > 1) {
            const binds = uniformDef.getUniformBufs(this, { num_active: numElems }, uniBufIx);
            this.#dispatchKernel(commandEncoder, pipeline, [getBuf(activeBufIx), getBuf(nextIx(activeBufIx))], numElems, binds);
            activeBufIx = nextIx(activeBufIx);
            numElems = Math.ceil(numElems / this.wgSize);
            uniBufIx++;
        }
        commandEncoder.copyBufferToBuffer(getBuf(activeBufIx), 0, resultBuf, resultBufOfs, 4);
        if (!cme) {
            this.device.queue.submit([commandEncoder.finish()]);
        }
    }

    /**
     * Run reduction. Reduce is slow if called many times, because of GPU->CPU copy.
     * In that case, you can use {@link reduceRaw}.
     * 
     * @param {string} fnName Function registered in {@link registerReduceFn}.
     * @param {VoxelGridGpu} inVg 
     * @returns {Promise<number>}
     * @async
     */
    async reduce(fnName, inVg) {
        const resultBuf = this.createBuffer(4);
        const readBuf = this.createBufferForCpuRead(4);

        this.reduceRaw(fnName, inVg, resultBuf, 0);
        const valType = this.reducePipelines[fnName].valType;
        await this.copyBuffer(resultBuf, readBuf, 4);
        resultBuf.destroy();

        await readBuf.mapAsync(GPUMapMode.READ);
        let result = null;
        if (valType === "u32") {
            result = new Uint32Array(readBuf.getMappedRange())[0];
        } else if (valType === "f32") {
            result = new Float32Array(readBuf.getMappedRange())[0];
        } else {
            throw "unexpected valType";
        }
        readBuf.unmap();
        readBuf.destroy();
        return result;
    }

    /**
     * Throws error if ty is not allowed in map/map2 or grid types.
     * @param {string} ty 
     */
    static checkAllowedType(ty) {
        if (ty !== "u32" && ty !== "f32" && ty !== "vec3f" && ty !== "vec4f" && ty !== "vec3u" && ty !== "vec4u") {
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
            "vec3u": 16, // 16, not 12, because of alignment. https://www.w3.org/TR/WGSL/#alignment-and-size
            "vec3f": 16, // 16, not 12, because of alignment. https://www.w3.org/TR/WGSL/#alignment-and-size
            "vec4u": 16,
            "vec4f": 16,
        }[ty];
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
     * Create non-mapped uniform buffer. Use GPUQueue.writeBuffer to populate.
     * @param {number} size Size in bytes
     * @returns {GPUBuffer} Created buffer
     */
    createUniformBufferNonMapped(size) {
        return this.device.createBuffer({
            label: "buf-uniform-nm",
            size: size,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
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
     * @param {number} numStorageBindings Number of main storage buffer bindings
     * @param {string} shaderCode WGSL code
     * @param {PipelineUniformDef} pipelineUniforms Pipeline uniforms
     * @returns {GPUComputePipeline} Created pipeline
     * @private
     */
    #createPipeline(entryPoint, numStorageBindings, shaderCode, pipelineUniforms) {
        const shaderModule = this.device.createShaderModule({ code: shaderCode, label: entryPoint });

        const bindEntries = [];
        for (let i = 0; i < numStorageBindings; i++) {
            bindEntries.push({
                binding: i,
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type: "storage" }
            });
        }
        for (const bindingId of pipelineUniforms.uniformBindingIds()) {
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
     * @param {{pipeline: GPUComputePipeline, uniforms: PipelineUniformDef}} pipeline Pipeline to use
     * @param {GPUBuffer[]} denseBinds Array of buffers to bind (assigned to binding 0, 1, 2, ...)
     * @param {number} numThreads Number of total threads (wanted kernel execs)
     * @param {[[number, GPUBuffer, number, number]]} sparseBinds Sparse entries to bind (bindingId, buffer, offset, size).
     * @private
     */
    #dispatchKernel(commandEncoder, pipeline, denseBinds, numThreads, sparseBinds = []) {
        const entries = denseBinds.map((buf, i) => ({ binding: i, resource: { buffer: buf } }));
        for (const [bindingId, buffer, offset, size] of sparseBinds) {
            entries.push({ binding: bindingId, resource: { buffer, offset, size } });
        }

        const bindGroup = this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: entries,
        });

        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.dispatchWorkgroups(Math.ceil(numThreads / this.wgSize));
        passEncoder.end();
    }

    ////////////////////////////////////////////////////////////////////////////////
    // 3D geometry & grid

    #initGridUtils() {
        this.#compileJumpFloodPipeline();
        this.#compileShapeQueryPipeline();

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

        this.registerMapFn("check_sdf", "u32", "u32", `
            if (vi == 0) {
              vo = 0;
            } else {
              var d = f32(0);
              ${uberSdfSnippet("p", "d")}
              vo = select(0u, 1u, d <= offset);
            }
        `, Object.assign({ offset: "f32" }, uberSdfUniformDefs));
        this.registerReduceFn("sum", "u32", "0u", `
            vo = vi1 + vi2;
        `);

        this.registerMapFn("fill1", "u32", "u32", `
            vo = 1u;
        `);
        this.registerMap2Fn("or", "u32", "u32", "u32", `
            if (vi1 > 0 || vi2 > 0) {
                vo = 1u;
            } else {
                vo = 0u;
            }
        `);
    }


    #gridUniformDefs(prefix = "") {
        // nums: numX, numY, numZ
        // ofs_res: xyz=ofs, w=res
        return { [prefix + "nums"]: "vec3u", [prefix + "ofs_res"]: "vec4f" };
    }

    #gridFns(prefix = "") {
        return `
            fn ${prefix}decompose_ix(ix: u32) -> vec3u {
                return vec3u(ix % ${prefix}nums.x, (ix / ${prefix}nums.x) % ${prefix}nums.y, ix / (${prefix}nums.x * ${prefix}nums.y));
            }

            fn ${prefix}compose_ix(ix3: vec3u) -> u32 {
                return ix3.x + ix3.y * ${prefix}nums.x + ix3.z * ${prefix}nums.x * ${prefix}nums.y;
            }

            fn ${prefix}cell_center(ix3: vec3u) -> vec3f {
                return (vec3f(ix3) + 0.5) * ${prefix}ofs_res.w + ${prefix}ofs_res.xyz;
            }
        `;
    }

    /**
     * Gets runtime uniform variables for {@link #gridUniformDefs}.
     * @param {VoxelGridGpu} grid
     * @param {string} prefix Prefix that matches what's given to {@link #gridUniformDefs} and {@link #gridFns}.
     * @returns {Object} Runtime uniform variables.
     */
    #gridUniformVars(grid, prefix = "") {
        return {
            [prefix + "nums"]: [grid.numX, grid.numY, grid.numZ],
            [prefix + "ofs_res"]: new Vector4(grid.ofs.x, grid.ofs.y, grid.ofs.z, grid.res),
        };
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
     * Destroy & free VoxelGrid's backing buffer.
     * @param {VoxelGridGpu} vg 
     */
    destroy(vg) {
        vg.buffer.destroy();
        vg.buffer = null;
    }

    /**
     * Writes "1" to all voxels contained in shape, "0" to other voxels.
     * 
     * @param {Object} shape 
     * @param {VoxelGridGpu} vg (in-place)
     * @param {"in" | "out" | "nearest"} boundary 
     * @returns {Promise<void>}
     * @async
     */
    async fillShape(shape, vg, boundary) {
        // TODO: Gen candidate big voxels & dispatch them.

        const options = { offset: this.boundaryOffset(vg, boundary) };
        Object.assign(options, uberSdfUniformVars(shape));

        const dummyVg = this.createLike(vg, "u32");
        this.fill1(dummyVg);
        const maskVg = this.createLike(vg, "u32");
        const tempVg = this.createLike(vg, "u32");
        await this.copy(vg, tempVg);
        this.map("check_sdf", dummyVg, maskVg, options);
        this.map2("or", maskVg, tempVg, vg);

        this.destroy(dummyVg);
        this.destroy(maskVg);
        this.destroy(tempVg);
    }

    /**
     * Compute distance field using jump flood algorithm.
     * O(N^3 log(N)) compute
     * 
     * @param {VoxelGridGpu<u32>} inSeedVg Positive cells = 0-distance (seed) cells.
     * @param {VoxelGridGpu<f32>} outDistVg Distance field. Distance from nearest seed cell will be written.
     */
    distField(inSeedVg, outDistVg) {
        const grid = this.#checkGridCompat(inSeedVg, outDistVg);

        // xyz=seed, w=dist. w=-1 means invalid (no seed) data.
        const df = this.createLike(inSeedVg, "vec4f");
        this.map("df_init", inSeedVg, df);

        // Jump flood
        const { pipeline, uniformDef } = this.jumpFloodPipeline;
        let numPass = Math.ceil(Math.log2(Math.max(grid.numX, grid.numY, grid.numZ)));

        const commandEncoder = this.device.createCommandEncoder();
        let ix = 0;
        for (let pass = 0; pass < numPass; pass++) {
            const step = 2 ** (numPass - pass - 1);
            const uniforms = { jump_step: step };
            Object.assign(uniforms, this.#gridUniformVars(grid));
            this.#dispatchKernel(commandEncoder, pipeline, [df.buffer], grid.numX * grid.numY * grid.numZ, uniformDef.getUniformBufs(this, uniforms, ix));
            ix++;
        }
        this.device.queue.submit([commandEncoder.finish()]);
        this.map("df_to_dist", df, outDistVg);
        this.destroy(df);
    }

    #compileJumpFloodPipeline() {
        const uniforms = {
            jump_step: "u32"
        };
        Object.assign(uniforms, this.#gridUniformDefs());
        const uniformDef = new PipelineUniformDef(uniforms);

        const pipeline = this.#createPipeline(`jump_flood`, 1, `
            @group(0) @binding(0) var<storage, read_write> df: array<vec4f>; // xyz:seed, w:dist (-1 is invalid)
            ${uniformDef.shaderVars()}

            ${this.#gridFns()}

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
                    let nix3 = vec3i(ix3) + offsets[i] * i32(jump_step);
                    if (any(nix3 < vec3i(0)) || any(nix3 >= vec3i(nums))) {
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
        `, uniformDef);
        this.jumpFloodPipeline = { pipeline, uniformDef };
    }

    #compileShapeQueryPipeline() {
        const uniforms = {
            block_size: "u32",
            fine_offset: "f32",
        };
        Object.assign(uniforms, this.#gridUniformDefs()); // fine grid
        Object.assign(uniforms, this.#gridUniformDefs("coarse_")); // coarse grid
        Object.assign(uniforms, uberSdfUniformDefs);
        const uniformDef = new PipelineUniformDef(uniforms);

        const pipeline = this.#createPipeline(`shape_query`, 2, `
            @group(0) @binding(0) var<storage, read_write> vs_in_fine: array<u32>;
            @group(0) @binding(1) var<storage, read_write> vs_out_coarse: array<u32>;
            ${uniformDef.shaderVars()}

            ${this.#gridFns()} // grid data for fine grid
            ${this.#gridFns("coarse_")} // grid data for coarse grid

            fn sdf(p: vec3f) -> f32 {
                var d = f32(0);
                ${uberSdfSnippet("p", "d")}
                return d;
            }

            @compute @workgroup_size(${this.wgSize})
            fn shape_query(@builtin(global_invocation_id) id: vec3u) {
                let gix = id.x;
                if (gix >= arrayLength(&vs_out_coarse)) {
                    return;
                }
                let coarse_ix3 = coarse_decompose_ix(gix);                

                // prune with coarse grid
                let coarse_p = coarse_cell_center(coarse_ix3);
                let coarse_offset = coarse_ofs_res.w * sqrt(3) * 0.5;
                if (sdf(coarse_p) > coarse_offset + fine_offset) {
                    vs_out_coarse[gix] = 0; // this block don't overlap with the shape
                    return;
                }
                
                // check all voxels in the block
                var num_hit = 0u;
                for (var dz = 0u; dz < block_size; dz++) {
                    for (var dy = 0u; dy < block_size; dy++) {
                        for (var dx = 0u; dx < block_size; dx++) {
                            let fine_ix3 = coarse_ix3 * block_size + vec3u(dx, dy, dz);
                            if (any(fine_ix3 >= nums)) {
                                continue;
                            }
                            let fine_ix = compose_ix(fine_ix3);
                            let fine_p = cell_center(fine_ix3);
                            if (vs_in_fine[fine_ix] == 0) {
                                continue;
                            }
                            if (sdf(fine_p) > fine_offset) {
                                continue;
                            }
                            num_hit++;
                        }
                    }
                }
                vs_out_coarse[gix] = num_hit;
            }
        `, uniformDef);
        this.shapeQueryPipeline = { pipeline, uniformDef };
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
        this.map("project_to_dir", inVg, projs, { dir });
        const min = await this.reduce("min_ignore_invalid", projs);
        const max = await this.reduce("max_ignore_invalid", projs);
        this.destroy(projs);
        const offset = this.boundaryOffset(inVg, boundary);
        return { min: min - offset, max: max + offset };
    }

    /**
     * Count existing cells inside the shape.
     * 
     * @param {Object} shape
     * @param {VoxelGridGpu} inVg(u32). Non-zero means exist.
     * @param {"in" | "out" | "nearest"} boundary
     * @param {GPUBuffer} resultBuf
     * @param {number} resultBufOffset result will be written to [resultBufOffset, resultBufOffset + 4) as u32.
     */
    countInShapeRaw(shape, inVg, boundary, resultBuf, resultBufOffset) {
        const BLOCK_SIZE = 4;
        const nbx = Math.floor(inVg.numX / BLOCK_SIZE) + 1;
        const nby = Math.floor(inVg.numY / BLOCK_SIZE) + 1;
        const nbz = Math.floor(inVg.numZ / BLOCK_SIZE) + 1;

        const cacheKey = `${nbx}x${nby}x${nbz}`;
        if (!this.countInShapeCache) {
            this.countInShapeCache = {};
        }
        if (!this.countInShapeCache[cacheKey]) {
            this.countInShapeCache[cacheKey] = new VoxelGridGpu(this, inVg.res * BLOCK_SIZE, nbx, nby, nbz, inVg.ofs, "u32");
        }
        const coarseVg = this.countInShapeCache[cacheKey];

        // Count all cells using coarse grid.
        const { pipeline, uniformDef } = this.shapeQueryPipeline;
        const uniforms = {
            block_size: BLOCK_SIZE,
            fine_offset: this.boundaryOffset(inVg, boundary),
        };
        Object.assign(uniforms, this.#gridUniformVars(inVg));
        Object.assign(uniforms, this.#gridUniformVars(coarseVg, "coarse_"));
        Object.assign(uniforms, uberSdfUniformVars(shape));

        const commandEncoder = this.device.createCommandEncoder();
        this.#dispatchKernel(commandEncoder, pipeline, [inVg.buffer, coarseVg.buffer], nbx * nby * nbz, uniformDef.getUniformBufs(this, uniforms));
    
        // Sum all cells using coarse grid.
        this.reduceRaw("sum", coarseVg, resultBuf, resultBufOffset, commandEncoder, 1); // 1, because of previous dispatch

        this.device.queue.submit([commandEncoder.finish()]);
        this.destroy(coarseVg);
    }

    /**
     * Count existing cells inside the shape.
     * 
     * @param {Object} shape
     * @param {VoxelGridGpu} inVg(u32). Non-zero means exist.
     * @param {"in" | "out" | "nearest"} boundary
     * @returns {Promise<number>}
     * @async
     */
    async countInShape(shape, inVg, boundary) {
        const resultBuf = this.createBuffer(4);
        const readBuf = this.createBufferForCpuRead(4);

        this.countInShapeRaw(shape, inVg, boundary, resultBuf, 0);
        await this.copyBuffer(resultBuf, readBuf, 4);
        resultBuf.destroy();

        await readBuf.mapAsync(GPUMapMode.READ);
        const result = new Uint32Array(readBuf.getMappedRange())[0];
        readBuf.unmap();
        readBuf.destroy();
        return result;
    }

    /**
     * Write "1" to all voxels.
     * @param {VoxelGridGpu} vg 
     */
    fill1(vg) {
        const dummyVg = this.createLike(vg);
        this.map("fill1", dummyVg, vg);
        this.destroy(dummyVg);
    }

    /**
     * Compute offset from voxel center to specified boundary.
     * 
     * @param {VoxelGridGpu} vg 
     * @param {"in" | "out" | "nearest"} boundary 
     * @returns {number} Offset
     */
    boundaryOffset(vg, boundary) {
        const maxVoxelCenterOfs = vg.res * Math.sqrt(3) * 0.5;
        const offset = {
            "in": -maxVoxelCenterOfs,
            "out": maxVoxelCenterOfs,
            "nearest": 0,
        }[boundary];
        if (offset === undefined) {
            throw new Error(`Invalid boundary: ${boundary}`);
        }
        return offset;
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
}
