// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * WebGPU-accelerated geometry operations including voxel grids and SDF (signed distance function) queries.
 * 
 * See https://iquilezles.org/articles/distfunctions/ for nice introduction to SDF.
 */
import { Vector3, Vector4 } from 'three';
import { Shape, createBoxShape, createCylinderShape, createELHShape, createSdf, VoxelGridCpu } from './cpu-geom.js';
import { UniformVariables, Pipeline, PipelineStorageDef, PipelineUniformDef, AllowedGpuType, sizeOfType } from './gpu-base.js';

export { Shape, createBoxShape, createCylinderShape, createELHShape, createSdf, VoxelGridCpu };

/**
 * Specifies voxel - shape intersection rounding behavior.
 * - In: voxel set is contained by the shape.
 * - Out: voxel set contains the shape.
 * - Nearest: voxel set is roughly same as the shape. Some voxels can be outside, some can be inside.
 */
export enum Boundary {
    In,
    Out,
    Nearest
}

/**
 * Uniform variable list for {@link uberSdfSnippet}.
 */
export const uberSdfUniformDefs: { [key: string]: AllowedGpuType } = {
    "_sd_ty": "u32",
    "_sd_p0": "vec3f",
    "_sd_p1": "vec3f",
    "_sd_p2": "vec3f",
    "_sd_p3": "vec3f",
};

/**
 * Generates SDF uniform variable dictionary for given shape.
 */
export const uberSdfUniformVars = (shape: Shape): { [key: string]: number | Vector3 } => {
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
    }
};

/**
 * Generates SDF snippet that can handle all shapes.
 */
export const uberSdfSnippet = (inVar: string, outVar: string): string => {
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
const wgslSdfCylinderSnippet = (inVar: string, outVar: string): string => {
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
const wgslSdfElhSnippet = (inVar: string, outVar: string): string => {
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
const wgslSdfBoxSnippet = (inVar: string, outVar: string): string => {
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
    kernels: GpuKernels;
    res: number;
    numX: number;
    numY: number;
    numZ: number;
    ofs: Vector3;
    type: AllowedGpuType;
    buffer: GPUBuffer;

    constructor(kernels: GpuKernels, res: number, numX: number, numY: number, numZ: number, ofs: Vector3 = new Vector3(), type: AllowedGpuType = "u32") {
        this.kernels = kernels;
        this.res = res;
        this.numX = numX;
        this.numY = numY;
        this.numZ = numZ;
        this.ofs = ofs.clone();
        this.type = type;
        this.buffer = kernels.createBuffer(numX * numY * numZ * sizeOfType(type));
    }
}

/**
 * GPU utilities.
 * Consisits of two layers
 * - 1D array part: no notion of geometry, just parallel data operation & wrappers.
 * - 3D voxel part: 1D array part + 3D geometry utils.
 */
export class GpuKernels {
    device: GPUDevice;
    sharedUniBuffer: GPUBuffer[] | null;
    wgSize: number;
    mapPipelines: { [key: string]: Pipeline };
    map2Pipelines: { [key: string]: Pipeline };
    reducePipelines: { [key: string]: Pipeline };
    invalidValue: number;
    jumpFloodPipeline: Pipeline;
    shapeQueryPipeline: Pipeline;
    connRegSweepPipeline: Pipeline;
    packPipeline: Pipeline;
    tempBufsCache: { [key: string]: GPUBuffer[] };
    countInShapeCache: { [key: string]: VoxelGridGpu } | null;

    constructor(device: GPUDevice) {
        this.device = device;
        this.sharedUniBuffer = null;
        this.wgSize = 128;

        this.mapPipelines = {};
        this.map2Pipelines = {};
        this.reducePipelines = {};

        this.#initGridUtils();
    }

    /**
     * Get or create shared uniform buffer pool for the PipelineUniformDef.getUniformBufs method
     */
    #getSharedUniBuffer(): GPUBuffer[] {
        const maxNumUniBuf = 10;
        const maxNumVars = 16;
        const entrySize = Math.max(16, this.device.limits.minUniformBufferOffsetAlignment);
        if (!this.sharedUniBuffer) {
            this.sharedUniBuffer = [];
            for (let i = 0; i < maxNumUniBuf; i++) {
                this.sharedUniBuffer.push(this.createUniformBufferNonMapped(entrySize * maxNumVars));
            }
        }
        return this.sharedUniBuffer;
    }


    /**
     * Copy data from inBuf to outBuf. This can cross CPU/GPU boundary.
     * Normally, size of inBuf and outBuf must match.
     * But if size is specified, size can differ as long as they're both same or larger than size.
     * 
     * @param copySize Size of data to copy.
     */
    async copyBuffer(inBuf: ArrayBuffer | GPUBuffer, outBuf: ArrayBuffer | GPUBuffer, copySize: number | null = null): Promise<void> {
        if (inBuf === outBuf) {
            return;
        }

        const inSize = inBuf instanceof ArrayBuffer ? inBuf.byteLength : inBuf.size;
        const outSize = outBuf instanceof ArrayBuffer ? outBuf.byteLength : outBuf.size;

        if (copySize === null) {
            if (inSize !== outSize) {
                throw new Error(`Buffer size mismatch: ${inSize} !== ${outSize}`);
            }
            copySize = inSize;
        } else if (inSize < copySize || outSize < copySize) {
            throw new Error(`Buffer is smaller than copySize: ${inSize} < ${copySize} || ${outSize} < ${copySize}`);
        }

        if (inBuf instanceof ArrayBuffer && outBuf instanceof ArrayBuffer) {
            // CPU->CPU: just clone
            new Uint8Array(outBuf, 0, copySize).set(new Uint8Array(inBuf, 0, copySize));
        } else if (inBuf instanceof ArrayBuffer && outBuf instanceof GPUBuffer) {
            // CPU->GPU: direct API.
            this.device.queue.writeBuffer(outBuf, 0, inBuf, 0, copySize);
        } else if (inBuf instanceof GPUBuffer && outBuf instanceof ArrayBuffer) {
            // GPU->CPU: via cpu-read buffer
            const tempBuf = this.createBufferForCpuRead(copySize);
            const commandEncoder = this.device.createCommandEncoder();
            commandEncoder.copyBufferToBuffer(inBuf, 0, tempBuf, 0, copySize);
            this.device.queue.submit([commandEncoder.finish()]);

            await tempBuf.mapAsync(GPUMapMode.READ);
            new Uint8Array(outBuf, 0, copySize).set(new Uint8Array(tempBuf.getMappedRange(0, copySize)));
            tempBuf.unmap();
            tempBuf.destroy();
        } else if (inBuf instanceof GPUBuffer && outBuf instanceof GPUBuffer) {
            // GPU->GPU: direct copy
            const commandEncoder = this.device.createCommandEncoder();
            commandEncoder.copyBufferToBuffer(inBuf, 0, outBuf, 0, copySize);
            this.device.queue.submit([commandEncoder.finish()]);
        } else {
            throw new Error("Unreachable: invalid buffer type combination");
        }
    }

    /**
     * Register WGSL snippet for use in {@link map}.
     * 
     * @param name (not shared with registerMap2Fn)
     * @param inType Type of input voxel
     * @param outType Type of output voxel
     * @param snippet (multi-line allowed)
     * @param uniforms Uniform variable defintions (can change for each invocation)
     * 
     * Snippet can use following variables:
     * - p: vec3f: voxel center position
     * - vi: <inType>: value of the voxel
     * - vo: <outType>: result
     * - index3: vec3u: raw 3-D array index
     * - index: u32: raw 1-D array index
     * -
     * 
     * At the end of snippet, vo must be assigned a value.
     * e.g. "vo = 0; if (vi == 1) { vo = 1; } else if (p.x > 0.5) { vo = 2; }"
     * 
     * You can assume in/out are always different buffers.
     */
    registerMapFn(name: string, inType: AllowedGpuType, outType: AllowedGpuType, snippet: string, uniforms: { [key: string]: AllowedGpuType } = {}) {
        if (this.mapPipelines[name]) {
            throw new Error(`Map fn "${name}" already registered`);
        }

        const storageDef = new PipelineStorageDef({ vs_in: inType, vs_out: outType });

        Object.assign(uniforms, this.#gridUniformDefs());
        const uniformDef = new PipelineUniformDef(uniforms);

        const code = `
            ${storageDef.shaderVars()}
            ${uniformDef.shaderVars()}

            ${this.#gridFns()}

            @compute @workgroup_size(${this.wgSize})
            fn map_${name}(@builtin(global_invocation_id) id: vec3u) {
                let index = id.x;
                if (index >= arrayLength(&vs_in)) {
                    return;
                }

                let index3 = decompose_ix(index);
                let p = cell_center(index3);
                let vi = vs_in[index];
                var vo = ${outType}();
                {
                    ${snippet}
                }
                vs_out[index] = vo;
            }
        `;
        this.mapPipelines[name] = this.#createPipeline(`map_${name}`, storageDef, uniformDef, code);
    }

    /**
     * Register WGSL expression snippet for use in {@link map2}.
     * 
     * @param name (not shared with registerMapFn)
     * @param inType1 Type of input voxel
     * @param inType2 Type of input voxel
     * @param outType Type of output voxel
     * @param snippet (multi-line allowed)
     * @param uniforms Uniform variable defintions (can change for each invocation)
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
    registerMap2Fn(name: string, inType1: AllowedGpuType, inType2: AllowedGpuType, outType: AllowedGpuType, snippet: string, uniforms: { [key: string]: AllowedGpuType } = {}) {
        if (this.map2Pipelines[name]) {
            throw new Error(`Map2 fn "${name}" already registered`);
        }

        const storageDef = new PipelineStorageDef({ vs_in1: inType1, vs_in2: inType2, vs_out: outType });

        Object.assign(uniforms, this.#gridUniformDefs());
        const uniformDef = new PipelineUniformDef(uniforms);

        this.map2Pipelines[name] = this.#createPipeline(`map2_${name}`, storageDef, uniformDef, `
            ${storageDef.shaderVars()}
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
        `);
    }

    /**
     * Register WGSL snippet for use in {@link reduce}.
     * 
     * @param name 
     * @param valType WGSL type signature of value type
     * @param initVal expression of initial value
     * @param snippet sentence(s) of reduce operation (multi-line allowed)
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
    registerReduceFn(name: string, valType: AllowedGpuType, initVal: string, snippet: string) {
        if (this.reducePipelines[name]) {
            throw new Error(`Reduce fn "${name}" already registered`);
        }
        /*
        if (valType !== "u32" && valType !== "f32") {
            throw new Error(`Reduce fn "${name}": valType must be "u32" or "f32"`);
        }
            */

        const storageDef = new PipelineStorageDef({ vs_in: valType, vs_out: valType });

        const uniforms: { [key: string]: AllowedGpuType } = { num_active: "u32" };
        const uniformDef = new PipelineUniformDef(uniforms);

        this.reducePipelines[name] = this.#createPipeline(`reduce_${name}`, storageDef, uniformDef, `
            var<workgroup> wg_buffer_accum: array<${valType}, ${this.wgSize}>;
            ${storageDef.shaderVars()}
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
        `);
    }

    /**
     * Run 1-input 1-output map.
     * @param fnName 
     * @param inVg 
     * @param outVg
     * @param uniforms Uniform variable values.
     */
    map(fnName: string, inVg: VoxelGridGpu, outVg: VoxelGridGpu, uniforms: UniformVariables = {}) {
        const pipeline = this.mapPipelines[fnName];
        if (!pipeline) {
            throw new Error(`Map fn "${fnName}" not registered`);
        }
        if (inVg === outVg) {
            throw new Error("inVg and outVg must be different");
        }
        const grid = this.#checkGridCompat(inVg, outVg);

        const storages = { vs_in: inVg.buffer, vs_out: outVg.buffer };
        uniforms = Object.assign({}, uniforms, this.#gridUniformVars(grid));

        pipeline.storageDef.checkInput(storages);
        pipeline.uniformDef.checkInput(uniforms);

        const commandEncoder = this.device.createCommandEncoder();
        this.#dispatchKernel(commandEncoder, pipeline, grid.numX * grid.numY * grid.numZ, storages, uniforms);
        this.device.queue.submit([commandEncoder.finish()]);
    }

    /**
     * Run 2-input 1-output map. (aka zip)
     * @param fnName 
     * @param inVg1 
     * @param inVg2 
     * @param outVg 
     * @param uniforms Uniform variable values.
     */
    map2(fnName: string, inVg1: VoxelGridGpu, inVg2: VoxelGridGpu, outVg: VoxelGridGpu, uniforms: UniformVariables = {}) {
        const pipeline = this.map2Pipelines[fnName];
        if (!pipeline) {
            throw new Error(`Map2 fn "${fnName}" not registered`);
        }
        if (inVg1 === outVg || inVg2 === outVg) {
            throw new Error("inVg1 or inVg2 must be different from outVg");
        }
        const grid = this.#checkGridCompat(inVg1, inVg2, outVg);

        const storages = { vs_in1: inVg1.buffer, vs_in2: inVg2.buffer, vs_out: outVg.buffer };
        uniforms = Object.assign({}, uniforms, this.#gridUniformVars(grid));

        pipeline.storageDef.checkInput(storages);
        pipeline.uniformDef.checkInput(uniforms);

        const commandEncoder = this.device.createCommandEncoder();
        this.#dispatchKernel(commandEncoder, pipeline, grid.numX * grid.numY * grid.numZ, storages, uniforms);
        this.device.queue.submit([commandEncoder.finish()]);
    }

    /**
     * Run reduction and store result to specfied location of the buffer.
     * 
     * @param fnName Function registered in {@link registerReduceFn}.
     * @param inVg 
     * @param resultBuf Buffer to store result.
     * @param resultBufOfs Result (4byte) is stored into [offset, offset+4) of resultBuf.
     * @param cme Optional external command encoder to use (if supplied, caller must call .submit()).
     * @param uniBufIxBegin Index of begin of uniform buffer bindings, when cme !== null.
     */
    reduceRaw(fnName: string, inVg: VoxelGridGpu, resultBuf: GPUBuffer, resultBufOfs: number, cme: GPUCommandEncoder | null = null, uniBufIxBegin: number = 0) {
        const pipeline = this.reducePipelines[fnName];
        if (!pipeline) {
            throw new Error(`Reduce fn "${fnName}" not registered`);
        }
        pipeline.storageDef.checkInput({ vs_in: inVg.buffer }, true);

        const valType = this.reducePipelines[fnName].storageDef.bindings["vs_in"].elemType; // A bit of hack.
        const valSize = sizeOfType(valType);

        // Dispatch like the following to minimize copy.
        // inVg -(reduce)-> buf0 -(reduce)-> buf1 -(reduce)-> buf0 -> ...
        const multOfValSize = (n) => {
            return Math.ceil(n / valSize) * valSize;
        };
        const bufSize = multOfValSize(Math.ceil(inVg.buffer.size / this.wgSize));
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
            const storages = { vs_in: getBuf(activeBufIx), vs_out: getBuf(nextIx(activeBufIx)) };
            const uniforms = { num_active: numElems };
            this.#dispatchKernel(commandEncoder, pipeline, numElems, storages, uniforms, uniBufIx);
            activeBufIx = nextIx(activeBufIx);
            numElems = Math.ceil(numElems / this.wgSize);
            uniBufIx++;
        }
        commandEncoder.copyBufferToBuffer(getBuf(activeBufIx), 0, resultBuf, resultBufOfs, valSize);
        if (!cme) {
            this.device.queue.submit([commandEncoder.finish()]);
        }
    }

    /**
     * Run reduction. Reduce is slow if called many times, because of GPU->CPU copy.
     * In that case, you can use {@link reduceRaw}.
     * 
     * @param fnName Function registered in {@link registerReduceFn}.
     * @param inVg 
     */
    async reduce(fnName: string, inVg: VoxelGridGpu): Promise<number | Uint32Array> {
        const valType = this.reducePipelines[fnName].storageDef.bindings["vs_in"].elemType; // A bit of hack.
        const valSize = sizeOfType(valType);

        const resultBuf = this.createBuffer(valSize);
        const readBuf = this.createBufferForCpuRead(valSize);

        this.reduceRaw(fnName, inVg, resultBuf, 0);

        await this.copyBuffer(resultBuf, readBuf, valSize);
        resultBuf.destroy();

        await readBuf.mapAsync(GPUMapMode.READ);
        let result = null;
        if (valType === "u32") {
            result = new Uint32Array(readBuf.getMappedRange())[0];
        } else if (valType === "f32") {
            result = new Float32Array(readBuf.getMappedRange())[0];
        } else if (valType === "array<u32,8>") {
            result = new Uint32Array(8);
            result.set(new Uint32Array(readBuf.getMappedRange()));
        } else {
            throw "unexpected valType";
        }
        readBuf.unmap();
        readBuf.destroy();
        return result;
    }

    /**
     * Filter data voxels by mask=1, and tightly pack resulting data into a buffer from the front.
     * This method does not provide final count; you need to get size using e.g. {@link reduce}.
     * 
     * @param maskVg (u32 type)
     * @param dataVg (vec4f type)
     * @param outBuf (vec4f type)
     */
    packRaw(maskVg: VoxelGridGpu, dataVg: VoxelGridGpu, outBuf: GPUBuffer) {
        const grid = this.#checkGridCompat(maskVg, dataVg);

        const uniforms = this.#gridUniformVars(grid);
        const bufCount = this.createBuffer(4);
        const commandEncoder = this.device.createCommandEncoder();
        this.#dispatchKernel(commandEncoder, this.packPipeline, grid.numX * grid.numY * grid.numZ, {
            vs_data: dataVg.buffer,
            vs_mask: maskVg.buffer,
            arr_out: outBuf,
            arr_index: bufCount,
        }, uniforms, 0);
        this.device.queue.submit([commandEncoder.finish()]);
        bufCount.destroy();
    }

    #compilePackPipeline() {
        const storageDef = new PipelineStorageDef({ vs_data: "vec4f", vs_mask: "u32", arr_out: "vec4f" }, { arr_index: "u32" });
        const uniformDef = new PipelineUniformDef(this.#gridUniformDefs());

        this.packPipeline = this.#createPipeline("pack", storageDef, uniformDef, `
            ${storageDef.shaderVars()}
            ${uniformDef.shaderVars()}

            ${this.#gridFns()}

            @compute @workgroup_size(${this.wgSize})
            fn pack(@builtin(global_invocation_id) id: vec3u) {
                let index = id.x;
                if (index >= arrayLength(&vs_data)) {
                    return;
                }

                let index3 = decompose_ix(index);
                if (vs_mask[index] > 0) {
                    arr_out[atomicAdd(&arr_index, 1u)] = vs_data[index];
                }
            }
        `);
    }


    /**
     * Create buffer for compute.
     * Supports: read/write from shader, bulk-copy from/to other buffer, very slow write from CPU
     * Does not support: bulk read to CPU
     */
    createBuffer(size: number): GPUBuffer {
        return this.device.createBuffer({
            label: "buf-storage",
            size: size,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
    }

    /**
     * Create uniform buffer & initialize with initFn.
     */
    createUniformBuffer(size: number, initFn: (buffer: ArrayBuffer) => void): GPUBuffer {
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
     * @param size Size in bytes
     * @returns Created buffer
     */
    createUniformBufferNonMapped(size: number): GPUBuffer {
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
     * @param size Size in bytes
     * @returns Created buffer
     */
    createBufferForCpuRead(size: number): GPUBuffer {
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
     * @param size Size in bytes
     * @returns Created buffer
     */
    createBufferForCpuWrite(size: number): GPUBuffer {
        return this.device.createBuffer({
            label: "buf-for-cpu-write",
            size: size,
            usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
        });
    }

    /**
     * Create a single pipeline.
     * @param entryPoint Entry point name
     * @param storageDef Storage variable definitions
     * @param uniformDef Pipeline uniforms
     * @param shaderCode WGSL code
     * @returns Created, wrapped pipeline
     */
    #createPipeline(entryPoint: string, storageDef: PipelineStorageDef, uniformDef: PipelineUniformDef, shaderCode: string): Pipeline {
        const shaderModule = this.device.createShaderModule({ code: shaderCode, label: entryPoint });

        const bindEntries = [];
        for (const bindingId of storageDef.bindingIds()) {
            bindEntries.push({
                binding: bindingId,
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type: "storage" }
            });
        }
        for (const bindingId of uniformDef.bindingIds()) {
            bindEntries.push({
                binding: bindingId,
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type: "uniform" }
            });
        }

        const bindGroupLayout = this.device.createBindGroupLayout({ entries: bindEntries, label: entryPoint });
        const pipeline = this.device.createComputePipeline({
            label: entryPoint,
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
            compute: { module: shaderModule, entryPoint }
        });
        return { pipeline, storageDef, uniformDef };
    }

    /**
     * Enqueue kernel dispatch to the command encoder.
     * @param numThreads Number of total threads (kernel executions). Note actual thread count will be higher (round up by this.wgSize).
     * @param uniBufIx Index of begin of uniform buffer bindings.
     */
    #dispatchKernel(
        commandEncoder: GPUCommandEncoder,
        pipeline: Pipeline,
        numThreads: number,
        storages: { [key: string]: GPUBuffer },
        uniforms: { [key: string]: any },
        uniBufIx: number = 0
    ): void {
        const { pipeline: gpuPipeline, storageDef, uniformDef } = pipeline;

        const entries = [];
        for (const [bindingId, buffer] of storageDef.getBinds(storages)) {
            entries.push({ binding: bindingId, resource: { buffer } });
        }
        for (const [bindingId, buffer, offset, size] of uniformDef.getUniformBufs(this.device, () => this.#getSharedUniBuffer(), uniforms, uniBufIx)) {
            entries.push({ binding: bindingId, resource: { buffer, offset, size } });
        }

        const bindGroup = this.device.createBindGroup({
            layout: gpuPipeline.getBindGroupLayout(0),
            entries: entries,
        });

        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(gpuPipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.dispatchWorkgroups(Math.ceil(numThreads / this.wgSize));
        passEncoder.end();
    }

    ////////////////////////////////////////////////////////////////////////////////
    // 3D geometry & grid

    #initGridUtils() {
        this.#compileJumpFloodPipeline();
        this.#compileShapeQueryPipeline();
        this.#compileConnRegSweepPipeline();
        this.#compilePackPipeline();
        this.invalidValue = 65536; // used in boundOfAxis.

        this.registerMapFn("connreg_init", "u32", "u32", `if (vi > 0) { vo = index; } else { vo = 0xffffffff; } `);
        this.registerMapFn("count_top4_init", "u32", "array<u32,8>", `vo = array<u32,8>(vi,1, 0xffffffff,0, 0xffffffff,0, 0xffffffff,0);`);
        this.registerReduceFn("count_top4_approx", "array<u32,8>", "array<u32,8>(0xffffffff,0, 0xffffffff,0, 0xffffffff,0, 0xffffffff,0)", `
            vo = vi1;
            // insert vi2
            for (var i2 = 0u; i2 < 4u; i2++) {
                let label2 = vi2[i2 * 2 + 0];
                let count2 = vi2[i2 * 2 + 1];
                if (label2 == 0xffffffff) {
                    break; // vi2 ended here
                }
                
                // Find insert location for existing label.
                var inserted = false;
                for (var io = 0u; io < 4u; io++) {
                    let labelo = vo[io * 2 + 0];
                    let counto = vo[io * 2 + 1];
                    if (labelo == label2) {
                        vo[io * 2 + 1] = counto + count2;
                        inserted = true;
                        break;
                    }
                }
                if (inserted) {
                    continue;
                }
                // Find insert location for empty slot.
                for (var io = 0u; io < 4u; io++) {
                    let labelo = vo[io * 2 + 0];
                    if (labelo == 0xffffffff) {
                        vo[io * 2 + 0] = label2;
                        vo[io * 2 + 1] = count2;
                        break;
                    }
                }
                // don't do anything even if insertion failed.
            }
        `);


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
        this.registerReduceFn("max", "f32", "f32(0)", `
            vo = max(vi1, vi2);
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


    #gridUniformDefs(prefix = ""): { [key: string]: AllowedGpuType } {
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
     * @param prefix Prefix that matches what's given to {@link #gridUniformDefs} and {@link #gridFns}.
     */
    #gridUniformVars(
        grid: VoxelGridGpu | { numX: number, numY: number, numZ: number, ofs: Vector3, res: number },
        prefix: string = ""
    ): { [key: string]: number[] | Vector4 } {
        return {
            [prefix + "nums"]: [grid.numX, grid.numY, grid.numZ],
            [prefix + "ofs_res"]: new Vector4(grid.ofs.x, grid.ofs.y, grid.ofs.z, grid.res),
        };
    }

    /**
     * Create new GPU-backed VoxelGrid, keeping shape of buf and optionally changing type.
     */
    createLike(
        vg: VoxelGridGpu | VoxelGridCpu,
        type: "u32" | "f32" | "vec3f" | "vec4f" | "vec3u" | "vec4u" | "array<u32,8>" | null = null
    ): VoxelGridGpu {
        return new VoxelGridGpu(this, vg.res, vg.numX, vg.numY, vg.numZ, vg.ofs, type ?? vg.type);
    }

    /**
     * Create new CPU-backed VoxelGrid, keeping shape of buf.
     */
    createLikeCpu(vg: VoxelGridGpu | VoxelGridCpu): VoxelGridCpu {
        if (vg.type !== "u32" && vg.type !== "f32") {
            throw new Error(`Cannot create CPU-backed VoxelGrid for type: ${vg.type}`);
        }
        return new VoxelGridCpu(vg.res, vg.numX, vg.numY, vg.numZ, vg.ofs, vg.type);
    }

    /**
     * Copy data from inBuf to outBuf. This can cross CPU/GPU boundary.
     */
    async copy(inVg: VoxelGridGpu | VoxelGridCpu, outVg: VoxelGridGpu | VoxelGridCpu): Promise<void> {
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
     */
    destroy(vg: VoxelGridGpu): void {
        vg.buffer.destroy();
        vg.buffer = null;
    }

    /**
     * Writes "1" to all voxels contained in shape, "0" to other voxels.
     */
    async fillShape(shape: Shape, vg: VoxelGridGpu, boundary: Boundary): Promise<void> {
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
     * @param inSeedVg (u32 type) Positive cells = 0-distance (seed) cells.
     * @param outDistVg (f32 type) Distance field. Distance from nearest seed cell will be written.
     */
    distField(inSeedVg: VoxelGridGpu, outDistVg: VoxelGridGpu): void {
        const grid = this.#checkGridCompat(inSeedVg, outDistVg);

        // xyz=seed, w=dist. w=-1 means invalid (no seed) data.
        const df = this.createLike(inSeedVg, "vec4f");
        this.map("df_init", inSeedVg, df);

        // Jump flood
        let numPass = Math.ceil(Math.log2(Math.max(grid.numX, grid.numY, grid.numZ)));

        const commandEncoder = this.device.createCommandEncoder();
        let uniBufIx = 0;
        const storages = { df: df.buffer };
        for (let pass = 0; pass < numPass; pass++) {
            const step = 2 ** (numPass - pass - 1);
            const uniforms = { jump_step: step };
            Object.assign(uniforms, this.#gridUniformVars(grid));
            this.#dispatchKernel(commandEncoder, this.jumpFloodPipeline, grid.numX * grid.numY * grid.numZ, storages, uniforms, uniBufIx);
            uniBufIx++;
        }
        this.device.queue.submit([commandEncoder.finish()]);
        this.map("df_to_dist", df, outDistVg);
        this.destroy(df);
    }

    #compileJumpFloodPipeline() {
        // df: xyz=seed, w=dist (-1 is invalid)
        const storageDef = new PipelineStorageDef({ df: "vec4f" });

        const uniforms: { [key: string]: AllowedGpuType } = { jump_step: "u32" };
        Object.assign(uniforms, this.#gridUniformDefs());
        const uniformDef = new PipelineUniformDef(uniforms);

        this.jumpFloodPipeline = this.#createPipeline(`jump_flood`, storageDef, uniformDef, `
            ${storageDef.shaderVars()}
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
        `);
    }

    #compileShapeQueryPipeline() {
        const storageDef = new PipelineStorageDef({ vs_in_fine: "u32", vs_out_coarse: "u32" });

        const uniforms: { [key: string]: AllowedGpuType } = {
            block_size: "u32",
            fine_offset: "f32",
        };
        Object.assign(uniforms, this.#gridUniformDefs()); // fine grid
        Object.assign(uniforms, this.#gridUniformDefs("coarse_")); // coarse grid
        Object.assign(uniforms, uberSdfUniformDefs);
        const uniformDef = new PipelineUniformDef(uniforms);

        this.shapeQueryPipeline = this.#createPipeline(`shape_query`, storageDef, uniformDef, `
            ${storageDef.shaderVars()}
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
        `);
    }

    /**
     * Get range of non-zero cells along dir.
     * 
     * @param dir Unit vector representing axis to check.
     * @param inVg non-zero means existence.
     * @param boundary
     */
    async boundOfAxis(dir: Vector3, inVg: VoxelGridGpu, boundary: Boundary): Promise<{ min: number, max: number }> {
        const projs = this.createLike(inVg, "f32");
        this.map("project_to_dir", inVg, projs, { dir });
        const min = (await this.reduce("min_ignore_invalid", projs)) as number;
        const max = (await this.reduce("max_ignore_invalid", projs)) as number;
        this.destroy(projs);
        const offset = this.boundaryOffset(inVg, boundary);
        return { min: min - offset, max: max + offset };
    }

    /**
     * Count existing cells inside the shape.
     * 
     * @param shape
     * @param inVg (u32). Non-zero means exist.
     * @param boundary
     * @param resultBuf
     * @param resultBufOffset result will be written to [resultBufOffset, resultBufOffset + 4) as u32.
     */
    countInShapeRaw(shape: Shape, inVg: VoxelGridGpu, boundary: Boundary, resultBuf: GPUBuffer, resultBufOffset: number) {
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

        const commandEncoder = this.device.createCommandEncoder();

        // Count all cells using coarse grid.
        const storages = { vs_in_fine: inVg.buffer, vs_out_coarse: coarseVg.buffer };
        const uniforms = {
            block_size: BLOCK_SIZE,
            fine_offset: this.boundaryOffset(inVg, boundary),
        };
        Object.assign(uniforms, this.#gridUniformVars(inVg));
        Object.assign(uniforms, this.#gridUniformVars(coarseVg, "coarse_"));
        Object.assign(uniforms, uberSdfUniformVars(shape));

        this.#dispatchKernel(commandEncoder, this.shapeQueryPipeline, nbx * nby * nbz, storages, uniforms);

        // Sum all cells using coarse grid.
        this.reduceRaw("sum", coarseVg, resultBuf, resultBufOffset, commandEncoder, 1); // 1, because of previous dispatch

        this.device.queue.submit([commandEncoder.finish()]);
    }

    /**
     * Count existing cells inside the shape.
     * 
     * @param shape
     * @param inVg (u32). Non-zero means exist.
     * @param boundary
     */
    async countInShape(shape: Shape, inVg: VoxelGridGpu, boundary: Boundary): Promise<number> {
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
     * Mark each connected region with unique ID, using 6-neighbor.
     * O(numFlood) dispatches, O(N^3 * numFlood) compute.
     * 
     * @param inVg (u32 type) exists flag (non-zero: exists, 0: not exists)
     * @param outVg (u32 type) output; contains ID that denotes connected region. 0xffffffff means no cell.
     * @param numFlood Number of floodings. For very simple shape, 1 is fine, and for "real-world" shape, 4 should be plenty.
     *   However, pathological shape would require 100s of passes. If numFlood is not enough, connected regions will return different IDs.
     */
    connectedRegions(inVg: VoxelGridGpu, outVg: VoxelGridGpu, numFlood: number = 4) {
        const grid = this.#checkGridCompat(inVg, outVg);
        this.map("connreg_init", inVg, outVg);

        const commandEncoder = this.device.createCommandEncoder();
        const uniformsX = { axis: 0 };
        Object.assign(uniformsX, this.#gridUniformVars(grid));
        const uniformsY = { axis: 1 };
        Object.assign(uniformsY, this.#gridUniformVars(grid));
        const uniformsZ = { axis: 2 };
        Object.assign(uniformsZ, this.#gridUniformVars(grid));
        for (let i = 0; i < numFlood; i++) {
            // Since uniform variables are independent of i and only depends on axis, it's ok to reuse uniBufIx.
            this.#dispatchKernel(commandEncoder, this.connRegSweepPipeline, grid.numY * grid.numZ, { vs: outVg.buffer }, uniformsX, 0);
            this.#dispatchKernel(commandEncoder, this.connRegSweepPipeline, grid.numZ * grid.numX, { vs: outVg.buffer }, uniformsY, 1);
            this.#dispatchKernel(commandEncoder, this.connRegSweepPipeline, grid.numX * grid.numY, { vs: outVg.buffer }, uniformsZ, 2);
        }
        this.device.queue.submit([commandEncoder.finish()]);
    }

    #compileConnRegSweepPipeline() {
        const storageDef = new PipelineStorageDef({ vs: "u32" });
        // axis={0, 1, 2} (X, Y, Z)
        // X-scan: dispatchIx = iy + num_y * iz
        // Y-scan: dispatchIx = iz + num_z * ix
        // Z-scan: dispatchIx = ix + num_x * iy
        const uniforms: { [key: string]: AllowedGpuType } = { axis: "u32" };
        Object.assign(uniforms, this.#gridUniformDefs());
        const uniformDef = new PipelineUniformDef(uniforms);

        this.connRegSweepPipeline = this.#createPipeline(`connreg_sweep`, storageDef, uniformDef, `
            ${storageDef.shaderVars()}
            ${uniformDef.shaderVars()}

            ${this.#gridFns()}

            const INVALID = u32(0xffffffff);

            @compute @workgroup_size(${this.wgSize})
            fn connreg_sweep(@builtin(global_invocation_id) id: vec3u) {
                let ix = id.x;

                var dir = vec3u(0);
                var num = u32(0);
                var ix3 = vec3u(0);
                if (axis == 0) {
                    if (ix >= nums.y * nums.z) {
                        return;
                    }
                    dir = vec3u(1, 0, 0);
                    num = nums.x;
                    ix3 = vec3u(0, ix % nums.y, ix / nums.y);
                } else if (axis == 1) {
                    if (ix >= nums.z * nums.x) {
                        return;
                    }
                    dir = vec3u(0, 1, 0);
                    num = nums.y;
                    ix3 = vec3u(ix / nums.z, 0, ix % nums.z);
                } else {
                    if (ix >= nums.x * nums.y) {
                        return;
                    }
                    dir = vec3u(0, 0, 1);
                    num = nums.z;
                    ix3 = vec3u(ix % nums.x, ix / nums.x, 0);
                }

                // + scan
                for (var i = 0u; i < num - 1; i++) {
                    let prev_ix = compose_ix(ix3 + dir * i);
                    let curr_ix = compose_ix(ix3 + dir * (i + 1));
                    let prev = vs[prev_ix];
                    let curr = vs[curr_ix];
                    if (prev != INVALID && curr != INVALID) {
                        vs[curr_ix] = min(prev, curr);
                    }
                }

                // - scan
                for (var i = 0u; i < num - 1; i++) {
                    let prev_ix = compose_ix(ix3 + dir * (num - i - 1));
                    let curr_ix = compose_ix(ix3 + dir * (num - i - 2));
                    let prev = vs[prev_ix];
                    let curr = vs[curr_ix];
                    if (prev != INVALID && curr != INVALID) {
                        vs[curr_ix] = min(prev, curr);
                    }
                }
            }
        `);
    }

    /**
     * Count top 4 labels, ignoring 0xffffffff.
     * Count will be approximate; correct for largest-by-far region,
     * but might discard smaller similar-sized regions even if they're in top-4.
     * 
     * @param vg (u32 type) 
     */
    async top4Labels(vg: VoxelGridGpu): Promise<Map<number, number>> {
        const histogramVg = this.createLike(vg, "array<u32,8>");
        this.map("count_top4_init", vg, histogramVg);

        const result = await this.reduce("count_top4_approx", histogramVg);
        this.destroy(histogramVg);

        const resultMap = new Map();
        for (let i = 0; i < 4; i++) {
            const label = result[i * 2 + 0];
            const count = result[i * 2 + 1];
            if (label === 0xffffffff) {
                break;
            }
            resultMap.set(label, count);
        }
        return resultMap;
    }

    /**
     * Write "1" to all voxels.
     */
    fill1(vg: VoxelGridGpu) {
        const dummyVg = this.createLike(vg);
        this.map("fill1", dummyVg, vg);
        this.destroy(dummyVg);
    }

    /**
     * Compute offset from voxel center to specified boundary.
     * 
     * @param vg 
     * @param boundary 
     * @returns Offset
     */
    boundaryOffset(vg: VoxelGridGpu, boundary: Boundary): number {
        const maxVoxelCenterOfs = vg.res * Math.sqrt(3) * 0.5;
        switch (boundary) {
            case Boundary.In:
                return -maxVoxelCenterOfs;
            case Boundary.Out:
                return maxVoxelCenterOfs;
            case Boundary.Nearest:
                return 0;
        }
    }

    /**
     * Throws error if grids are not compatible and returns common grid parameters.
     * @param vg1 
     * @param vgs Additional grids to check compatibility with
     * @returns Common grid parameters
     */
    #checkGridCompat(vg1: VoxelGridGpu | VoxelGridCpu, ...vgs: (VoxelGridGpu | VoxelGridCpu)[]): { res: number, numX: number, numY: number, numZ: number, ofs: Vector3 } {
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
