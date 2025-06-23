// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Base GPU utilities and pipeline management.
 * These are non-geometry specific GPU abstractions.
 */
import { Vector3, Vector4 } from 'three';

// WebGPU type definitions
export type UniformVariables = { [key: string]: number | number[] | Vector3 | Vector4 | boolean };

export interface Pipeline {
    pipeline: GPUComputePipeline;
    storageDef: PipelineStorageDef;
    uniformDef: PipelineUniformDef;
}

// Generic interface for buffer-like objects to avoid circular dependencies
interface BufferLike {
    buffer: GPUBuffer;
    type: string;
}

/**
 * Throws error if ty is not allowed in map/map2 or grid types.
 */
export function checkAllowedType(ty: string): void {
    // Special handling for now, because array is only used in one place.
    if (ty === "array<u32,8>") {
        return;
    }
    if (ty !== "u32" && ty !== "f32" && ty !== "vec3f" && ty !== "vec4f" && ty !== "vec3u" && ty !== "vec4u") {
        throw new Error("Invalid type: " + ty);
    }
}

/**
 * Returns on-memory size of type (that passes {@link checkAllowedType}).
 */
export function sizeOfType(ty: string): number {
    return {
        "u32": 4,
        "f32": 4,
        "vec3u": 16, // 16, not 12, because of alignment. https://www.w3.org/TR/WGSL/#alignment-and-size
        "vec3f": 16, // 16, not 12, because of alignment. https://www.w3.org/TR/WGSL/#alignment-and-size
        "vec4u": 16,
        "vec4f": 16,
        "array<u32,8>": 32,
    }[ty];
}

/**
 * Represents storage variable definition of a single GPU Pipeline.
 */
export class PipelineStorageDef {
    static BINDING_ID_BEGIN = 0;

    bindings: { [varName: string]: { bindingId: number, elemType: string } };
    shader: string;

    /**
     * @param defs Storage array<> variable defintions (can change for each invocation).
     * @param atomicDefs Storage atomic<> variable defintions (can change for each invocation).
     */
    constructor(defs: { [key: string]: string }, atomicDefs: { [key: string]: string } = {}) {
        let bindingId = PipelineStorageDef.BINDING_ID_BEGIN;
        const shaderLines = [];
        this.bindings = {};
        for (const [varName, elemType] of Object.entries(defs)) {
            shaderLines.push(`@group(0) @binding(${bindingId}) var<storage, read_write> ${varName}: array<${elemType}>;`);
            this.bindings[varName] = {
                bindingId: bindingId,
                elemType: elemType,
            };
            bindingId++;
        }
        for (const [varName, elemType] of Object.entries(atomicDefs)) {
            shaderLines.push(`@group(0) @binding(${bindingId}) var<storage, read_write> ${varName}: atomic<${elemType}>;`);
            this.bindings[varName] = {
                bindingId: bindingId,
                elemType: elemType,
            };
            bindingId++;
        }
        this.shader = shaderLines.join("\n") + "\n";
    }

    /**
     * Get multi-line shader storage variable declarations.
     * @returns Multi-line shader storage variable declarations. (e.g. "@group(0) @binding(0) var<storage, read_write> df: array<vec4f>;")
     */
    shaderVars(): string {
        return this.shader;
    }

    /**
     * Get binding IDs. (order might not match what's given to constructor)
     * @returns Binding IDs of storage variables.
     */
    bindingIds(): number[] {
        return Object.values(this.bindings).map(({ bindingId }) => bindingId);
    }

    /**
     * Validate input values.
     * @param vals Storage variable values
     * @param allowPartial Don't rise error if some variables are missing. Useful for multi-pass advanced pipelines.
     * @throws If any input is invalid.
     */
    checkInput(vals: { [key: string]: GPUBuffer | BufferLike }, allowPartial: boolean = false): void {
        const unknownVars = new Set(Object.keys(vals)).difference(new Set(Object.keys(this.bindings)));
        if (unknownVars.size > 0) {
            console.warn("Unknown buffer provided: ", unknownVars);
        }
        for (const [varName, { elemType }] of Object.entries(this.bindings)) {
            const val = vals[varName];
            if (val === undefined) {
                if (allowPartial) {
                    continue;
                } else {
                    throw new Error(`Required buffer variable "${varName}" not provided`);
                }
            }
            // Check type compatibility
            if (val && typeof val === 'object' && 'buffer' in val && 'type' in val) {
                // BufferLike object (VoxelGridGpu)
                if (val.type !== elemType) {
                    throw new Error(`"${varName}: array<${elemType}>" type mismatch; got ${val.type}`);
                }
                continue;
            }
            if (val && typeof val === 'object' && 'size' in val && 'destroy' in val) {
                // Likely a GPUBuffer
                continue;
            }
            throw new Error(`"${varName}: array<${elemType}>" got unsupported type: ${typeof val}`);
        }
    }

    /**
     * Get buffer bindings for given values.
     * @param bufs Storage variable values
     * @returns Buffer bindings. (bindingId, buffer)
     */
    getBinds(bufs: { [key: string]: GPUBuffer | BufferLike }): [number, GPUBuffer][] {
        this.checkInput(bufs);

        const binds: [number, GPUBuffer][] = [];
        for (const [varName, val] of Object.entries(bufs)) {
            if (val && typeof val === 'object' && 'buffer' in val) {
                // BufferLike object (VoxelGridGpu)
                binds.push([this.bindings[varName].bindingId, val.buffer]);
            } else {
                // GPUBuffer
                binds.push([this.bindings[varName].bindingId, val as GPUBuffer]);
            }
        }
        return binds;
    }
}

/**
 * Represents uniform variable definition of a single GPU Pipeline.
 */
export class PipelineUniformDef {
    static BINDING_ID_BEGIN = 100;

    bindings: { [varName: string]: { bindingId: number, type: string } };
    shader: string;

    /**
     * @param defs Uniform variable defintions (can change for each invocation).
     */
    constructor(defs: { [key: string]: string }) {
        let uniformBindingId = PipelineUniformDef.BINDING_ID_BEGIN;
        const shaderLines = [];
        this.bindings = {};
        for (const [varName, type] of Object.entries(defs)) {
            checkAllowedType(type);
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
     * @returns Multi-line shader uniform variable declarations. (e.g. "@group(0) @binding(200) var<uniform> dir: vec3f;\n ...")
     */
    shaderVars(): string {
        return this.shader;
    }

    /**
     * Get binding IDs. (order might not match what's given to constructor)
     * @returns Binding IDs of uniform variables.
     */
    bindingIds(): number[] {
        return Object.values(this.bindings).map(({ bindingId }) => bindingId);
    }

    /**
     * Check runtime inputs can be handled correctly by this pipeline uniform definition.
     * @param vars Uniform variable values
     * @throws If any input is invalid.
     */
    checkInput(vars: UniformVariables): void {
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
     * @returns Array of numbers or null if invalid.
     */
    extractArrayLikeOrVector(expectedLen: number, val: number[] | Vector3 | Vector4 | any): number[] | null {
        // Check for Vector3/Vector4 instances first
        if (val instanceof Vector3 && expectedLen === 3) {
            return [val.x, val.y, val.z];
        }
        if (val instanceof Vector4 && expectedLen === 4) {
            return [val.x, val.y, val.z, val.w];
        }

        // Handle arrays
        if (Array.isArray(val) && val.length === expectedLen) {
            // Check all elements are numbers
            for (let i = 0; i < expectedLen; i++) {
                if (typeof val[i] !== "number") {
                    return null;
                }
            }
            return val as number[];
        }

        // Invalid for vector/array types
        return null;
    }

    /**
     * Return uniform buffers by setting given values.
     * 
     * Multiple uniform variables can be handled by a single buffer.
     * Multiple uniform buffers can be used in a single shader, for advanced usage.
     * 
     * The returned bind group should be attached to @group(0).
     * 
     * To pass variables whose values change between dispatches:
     * this will allocate-and-write (slow) to individual buffers for each uniform variable.
     * 
     * Multiple dispatches in single CommandBuffer, using different uniform variable values:
     * this will use pre-allocated shared "pool" of buffers. The buffers are written to once.
     * But the caller should choose different uniBufIx for each dispatch. See example.
     * 
     * // Bad Example
     * const cme = device.createCommandEncoder();
     * const bind1 = pipeline.createBuffers(kernels, vars1, 0);
     * cme.dispatch(..., bind1);
     * const bind2 = pipeline.createBuffers(kernels, vars2, 0); // overwrites bind1 !!!
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
     * @param device GPU device for buffer operations
     * @param getSharedUniBuffer Function to get shared uniform buffer pool
     * @param vars Uniform variable values
     * @param uniBufIx Index of the uniform buffer to use. (Needed when doing multiple dispatches in single CommandBuffer)
     * @throws If any input is invalid.
     * @returns Array of [bindingId, buffer, offset, size]
     */
    getUniformBufs(device: GPUDevice, getSharedUniBuffer: () => GPUBuffer[], vars: UniformVariables, uniBufIx: number = 0): [number, GPUBuffer | null, number, number][] {
        const maxNumUniBuf = 10;
        const maxNumVars = 16;
        const entrySize = Math.max(16, device.limits.minUniformBufferOffsetAlignment);
        const sharedUniBuffer = getSharedUniBuffer();

        this.checkInput(vars);

        if (Object.entries(this.bindings).length > maxNumVars) {
            throw new Error("Too many uniform variables");
        }
        if (uniBufIx >= maxNumUniBuf) {
            throw new Error("Too many uniform buffers at the same time");
        }

        const binds = [] as [number, GPUBuffer | null, number, number][];
        const uniBuf = sharedUniBuffer[uniBufIx];
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
                if (nums === null) throw new Error(`Invalid vec4f value for ${varName}`);
                new Float32Array(cpuBuf, entryOffset, 4).set(nums);
            } else if (type === "vec3f") {
                const nums = this.extractArrayLikeOrVector(3, val);
                if (nums === null) throw new Error(`Invalid vec3f value for ${varName}`);
                new Float32Array(cpuBuf, entryOffset, 3).set(nums);
            } else if (type === "vec4u") {
                const nums = this.extractArrayLikeOrVector(4, val);
                if (nums === null) throw new Error(`Invalid vec4u value for ${varName}`);
                new Uint32Array(cpuBuf, entryOffset, 4).set(nums);
            } else if (type === "vec3u") {
                const nums = this.extractArrayLikeOrVector(3, val);
                if (nums === null) throw new Error(`Invalid vec3u value for ${varName}`);
                new Uint32Array(cpuBuf, entryOffset, 3).set(nums);
            } else if (type === "f32") {
                new Float32Array(cpuBuf, entryOffset, 1).set([val as number]);
            } else if (type === "u32") {
                new Uint32Array(cpuBuf, entryOffset, 1).set([val as number]);
            }
            binds.push([bindingId, null, entryOffset, entrySize]);
            ix++;
        }
        device.queue.writeBuffer(uniBuf, 0, cpuBuf, 0, cpuBuf.byteLength);
        for (const bind of binds) {
            bind[1] = uniBuf;
        }
        return binds;
    }
}