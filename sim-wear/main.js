import * as THREE from 'three';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RadixSortKernel} from 'radix-sort';

// Units
// distance: mm
// time: sec

// Represents connected metal.
class Shape {
    // Specify solid in world coordinates. shape is generated in local coordinates, then rotated, and then translated by offset.
    // Shape is generally centered at the origin of local coordinates, and "special" axis pointing in Z.
    // [in] shapeType: "box" | "cylinder"
    // [in] shapeParams
    //   shapeType == "box": { size: THREE.Vector3 }
    //   shapeType == "cylinder": { diameter, height } (diamter: XY, height: Z length)
    constructor(shapeType, shapeParams) {
        this.shapeType = shapeType;
        this.shapeParams = shapeParams;
        if (shapeType === "box") {
            this.sizeLocal = shapeParams.size;
        } else if (shapeType === "cylinder") {
            this.sizeLocal = new THREE.Vector3(shapeParams.diameter, shapeParams.diameter, shapeParams.height);
        } else {
            throw new Error(`Unknown shape type: ${shapeType}`);
        }
    }
}

class GpuKernels {
    constructor(device) {
        this.device = device;
        this.#compileInit();
        this.#compileApplyCylinder();
        this.#compileApplyTransform();
        this.#compileComputeAABB();
        this.#compileGatherActive();
        this.#compileComputeCellIx();
        this.#compileIndexGrouping();
        this.#compileComputeMins();
        this.#compileRadixPadding();
        this.#compileComputeNormal();
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
            layout: this.device.createPipelineLayout({bindGroupLayouts: [bindGroupLayout]}),
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

    // Gets (or rebuild) Radix sort kernel and usable buffers.
    // Returned buffers are guaranteed to be large enough to hold count elements.
    // Caller MUST NOT use 0xffffffff as keys, as they're internally used as padding.
    // Caller MUST copy the result to other buffers before calling this method again.
    //
    // Kernel recompiles iff count is bigger than previous ones.
    //
    // [in] count: number, number of elements
    // returns {keysBuf (u32 buf), valuesBuf (u32 buf), kernel: RadixSortKernel}
    #prepareCachedRadixSortKernel(count, commandEncoder) {
        if (!this.cachedRadixSortSize || this.cachedRadixSortSize < count) {
            // rebuild
            const keysBuf = this.createBuffer(count * 4);
            const valuesBuf = this.createBuffer(count * 4);
            const kernel = new RadixSortKernel({
                device: this.device,
                keys: keysBuf,
                values: valuesBuf,
                count: count,
            });
            this.cachedRadixSortSize = count;
            this.cachedRadixSort = { keysBuf, valuesBuf, kernel };
        }

        // Pad key buffer. (So that these unused elements will go to the end of the array)
        this.#dispatchKernel(commandEncoder, this.padForRadixSortPipeline, [this.cachedRadixSort.keysBuf], this.cachedRadixSortSize);
        
        return this.cachedRadixSort;
    }

    async debugPrintBuffer(mark, buf) {
        const SIZE_LIMIT = 128;
        const size = Math.min(buf.size, SIZE_LIMIT);

        let usage = buf.usage;
        const usageStrs = [];
        const usageFlags = [
            [GPUBufferUsage.MAP_READ, "MAP_READ"],
            [GPUBufferUsage.MAP_WRITE, "MAP_WRITE"], 
            [GPUBufferUsage.COPY_DST, "COPY_DST"],
            [GPUBufferUsage.COPY_SRC, "COPY_SRC"],
            [GPUBufferUsage.UNIFORM, "UNIFORM"],
            [GPUBufferUsage.STORAGE, "STORAGE"]
        ];
        for (const [flag, name] of usageFlags) {
            if (usage & flag) {
                usageStrs.push(name);
                usage &= ~flag;
            }
        }
        if (usage) {
            usageStrs.push(`${usage.toString(16)}`);
        }

        // Somehow copy to cpu buffer
        const dumpString = `${mark}:Buffer label=${buf.label} size=${buf.size} usage=${usageStrs.join("|")} map=${buf.mapState}`;
        if (buf.usage & GPUBufferUsage.COPY_SRC) {
            // copiable
            const debugBuffer = this.createBufferForCpuRead(size);
            await this.device.queue.onSubmittedWorkDone();
            
            const commandEncoder = this.device.createCommandEncoder();
            commandEncoder.copyBufferToBuffer(buf, 0, debugBuffer, 0, size);
            this.device.queue.submit([commandEncoder.finish()]);
            await this.device.queue.onSubmittedWorkDone();
            await debugBuffer.mapAsync(GPUMapMode.READ);
            const cpuDebugBuffer = debugBuffer.getMappedRange(0, size).slice(); // NOTE: "slice" copies data
            debugBuffer.unmap();

            console.log(dumpString);
            console.log(`${mark}:Buffer/First ${size}B as f32`, new Float32Array(cpuDebugBuffer));
            console.log(`${mark}:Buffer/First ${size}B as u8`, new Uint8Array(cpuDebugBuffer));
        } else {
            console.log(dumpString);
            console.log(`${mark}:Buffer/Not copiable`);
        }
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

    #compileComputeCellIx() {
        this.computeCellIxPipeline = this.#createPipeline("compute_cell_ix", ["storage", "storage", "storage", "uniform"], `
                ${GpuKernels.#gridSnippet}
                
                @group(0) @binding(0) var<storage, read_write> ps_in: array<vec4<f32>>; // length = number of points
                @group(0) @binding(1) var<storage, read_write> pixs_out: array<u32>; // length = number of points
                @group(0) @binding(2) var<storage, read_write> cixs_out: array<u32>; // length = number of points
                @group(0) @binding(3) var<uniform> grid: AABBGrid;

                @compute @workgroup_size(128)
                fn compute_cell_ix(@builtin(global_invocation_id) gid: vec3<u32>) {
                    if (gid.x >= arrayLength(&ps_in)) {
                        return;
                    }
                    let p = ps_in[gid.x];
                    pixs_out[gid.x] = gid.x;
                    cixs_out[gid.x] = cell_ix(p.xyz, grid);
                }
            `
        );
    }

    #compileComputeNormal() {
        this.computeNormalPipeline = this.#createPipeline("compute_normal", ["storage", "storage", "storage", "storage", "uniform", "storage"], `
            ${GpuKernels.#gridSnippet}
            
            // input: P points
            @group(0) @binding(0) var<storage, read_write> ps_in: array<vec4<f32>>; // length = number of P points, order = original P point order
            @group(0) @binding(1) var<storage, read_write> ixs_in: array<u32>; // length = number of P points, order = sorted cell entry
            @group(0) @binding(2) var<storage, read_write> cgs_begin_in: array<u32>; // length = number of P cells
            @group(0) @binding(3) var<storage, read_write> cgs_end_in: array<u32>; // length = number of P cells
            @group(0) @binding(4) var<uniform> grid: AABBGrid;

            // output
            @group(0) @binding(5) var<storage, read_write> normals: array<vec4<f32>>; // xyz: normal (0 if inside), w: unused

            @compute @workgroup_size(128)
            fn compute_normal(@builtin(global_invocation_id) gid: vec3<u32>) {
                if (gid.x >= arrayLength(&ps_in)) {
                    return;
                }
                let p = ps_in[gid.x].xyz;

                // Accumulate points within sphere of radius d (center p), by searching 27 neighbors.
                var accum = vec3f();
                var n = 0;

                let cix3 = vec3i(cell_ix3(p, grid));
                for (var dz = -1; dz <= 1; dz++) {
                    for (var dy = -1; dy <= 1; dy++) {
                        for (var dx = -1; dx <= 1; dx++) {
                            let cix3 = cix3 + vec3i(dx, dy, dz);
                            if (any(cix3 < vec3i(0))) {
                                continue;
                            }
                            if (any(cix3 >= vec3i(grid.dims.xyz))) {
                                continue;
                            }
                            let cix = cell_3to1(vec3u(cix3), grid);
                            let begin = cgs_begin_in[cix];
                            let end = cgs_end_in[cix];
                            if (begin == end) {
                                continue; // cell is empty
                            }
                            
                            for (var q_ent_ix = begin; q_ent_ix < end; q_ent_ix++) {
                                let qix = ixs_in[q_ent_ix];
                                let q = ps_in[qix].xyz;
                                let dist = distance(p.xyz, q);
                                // to remove anistropy, reject points outside a sphere.
                                if (dist > grid.min_unit.w) {
                                    continue;
                                }
                                // also remove query point itself
                                if (qix == gid.x) {
                                    continue;
                                }
                                // accumulate (Welford's online algorithm)
                                n += 1;
                                accum += q;
                            }
                        }
                    }
                }
                if (n < 1) {
                    // weird situation; no neighbors found
                    normals[gid.x] = vec4f(0.0);
                    return;
                }
                let mean = accum * (1.0 / f32(n));

                let normal = (p.xyz - mean.xyz) / grid.min_unit.w;
                let len = length(normal);
                // heuristic: if mean point is too close, assume p is inside the volume.
                if (len < 0.2) {
                    normals[gid.x] = vec4f(0.0);
                } else {
                    normals[gid.x] = vec4f(normalize(normal), 0.0);
                }
            }
        `
    );
    }

    #compileComputeMins() {
        this.computeMinsPipeline = this.#createPipeline("compute_mins", ["storage", "storage", "storage", "storage", "storage", "uniform", "storage"],  `
                ${GpuKernels.#gridSnippet}
                
                // input: P points
                @group(0) @binding(0) var<storage, read_write> ps_in: array<vec4<f32>>; // length = number of P points, order = original P point order

                // input: Q points & index
                @group(0) @binding(1) var<storage, read_write> qs_in: array<vec4<f32>>; // length = number of Q points, order = original Q point order
                @group(0) @binding(2) var<storage, read_write> qixs_in: array<u32>; // length = number of Q points, order = sorted cell entry
                @group(0) @binding(3) var<storage, read_write> qcgs_begin_in: array<u32>; // length = number of Q cells
                @group(0) @binding(4) var<storage, read_write> qcgs_end_in: array<u32>; // length = number of Q cells
                @group(0) @binding(5) var<uniform> qgrid: AABBGrid;

                // output
                @group(0) @binding(6) var<storage, read_write> dists_out: array<u32>; // quantized distance (in 0.1 um; 16bit; truncated to < 6mm), length = number of P points

                @compute @workgroup_size(128)
                fn compute_mins(@builtin(global_invocation_id) gid: vec3<u32>) {
                    if (gid.x >= arrayLength(&ps_in)) {
                        return;
                    }
                    let p = ps_in[gid.x].xyz;

                    // Search 27 neighbor cells and find nearest point in Q.
                    var min_dist = 1e10;
                    let qcix3 = vec3i(cell_ix3(p, qgrid));
                    for (var dz = -1; dz <= 1; dz++) {
                        for (var dy = -1; dy <= 1; dy++) {
                            for (var dx = -1; dx <= 1; dx++) {
                                let cix3 = qcix3 + vec3i(dx, dy, dz);
                                if (any(cix3 < vec3i(0))) {
                                    continue;
                                }
                                if (any(cix3 >= vec3i(qgrid.dims.xyz))) {
                                    continue;
                                }
                                let cix = cell_3to1(vec3u(cix3), qgrid);
                                let begin = qcgs_begin_in[cix];
                                let end = qcgs_end_in[cix];
                                if (begin == end) {
                                    continue; // cell is empty
                                }
                                
                                for (var q_ent_ix = begin; q_ent_ix < end; q_ent_ix++) {
                                    let qix = qixs_in[q_ent_ix];
                                    let d = distance(p.xyz, qs_in[qix].xyz);
                                    min_dist = min(min_dist, d);
                                }
                            }
                        }
                    }
                    
                    let quantized_dist = min(u32(min_dist * 1e4), 0xffff); // truncated to 16bit for faster radix sort
                    dists_out[gid.x] = quantized_dist;
                }
            `
        );

        this.populateIxsPipeline = this.#createPipeline("populate_ixs", ["storage"], `
                @group(0) @binding(0) var<storage, read_write> ixs_out: array<u32>;

                @compute @workgroup_size(128)
                fn populate_ixs(@builtin(global_invocation_id) gid: vec3<u32>) {
                    let ix = gid.x;
                    if (ix >= arrayLength(&ixs_out)) {
                        return;
                    }
                    ixs_out[ix] = ix;
                }
            `
        );
    }

    #compileIndexGrouping() {
        this.clearGroupsPipeline = this.#createPipeline("clear_groups", ["storage", "storage"], `
                @group(0) @binding(0) var<storage, read_write> begin_out: array<u32>; // inclusive, length = number of cells
                @group(0) @binding(1) var<storage, read_write> end_out: array<u32>; // exclusive, length = number of cells

                @compute @workgroup_size(128)
                fn clear_groups(@builtin(global_invocation_id) gid: vec3<u32>) {
                    let ix = gid.x;
                    if (ix >= arrayLength(&begin_out)) {
                        return;
                    }
                    begin_out[ix] = 0;
                    end_out[ix] = 0;
                }
            `
        );

        this.detectGroupsPipeline = this.#createPipeline("detect_groups", ["storage", "storage", "storage"], `
                @group(0) @binding(0) var<storage, read_write> cixs_in: array<u32>; // length = number of points
                @group(0) @binding(1) var<storage, read_write> begin_out: array<u32>; // inclusive, length = number of cells
                @group(0) @binding(2) var<storage, read_write> end_out: array<u32>; // exclusive, length = number of cells

                @compute @workgroup_size(128)
                fn detect_groups(@builtin(global_invocation_id) gid: vec3<u32>) {
                    let ix = gid.x;
                    let n = arrayLength(&cixs_in);
                    if (ix >= n) {
                        return;
                    }

                    var cix_prev = 0xffffffffu;
                    let cix_curr = cixs_in[ix];
                    var cix_next = 0xffffffffu;
                    if (ix > 0) {
                        cix_prev = cixs_in[ix - 1];
                    }
                    if (ix < n - 1) {
                        cix_next = cixs_in[ix + 1];
                    }
                    
                    if (cix_prev != cix_curr) {
                        begin_out[cix_curr] = ix;
                    }
                    if (cix_next != cix_curr) {
                        end_out[cix_curr] = ix + 1;
                    }
                }
            `
        );
    }

    // Create a grid index.
    // [in] psIn: array<vec4f>
    // [in] grid: {min: THREE.Vector3, max: THREE.Vector3, unit: number (cell size)}
    //    unit is also the max distance that can be queried by getClosePoints.
    // returns: some opaque object that can be passed to getClosePoints, and getNormals
    async createGridIndex(psIn, grid) {
        // flow: compute cell ix -> sort by cell ix (keeps ix mapping table to pixsBuf) -> create cell begin/end table (beginBuf/endBuf)

        const numPoints = psIn.size / 16;
        const dims = grid.max.clone().sub(grid.min).divideScalar(grid.unit).floor().addScalar(1);
        const numCells = dims.x * dims.y * dims.z;

        const commandEncoder = this.device.createCommandEncoder();

        const pixsBuf = this.createBuffer(numPoints * 4);
        const cixsBuf = this.createBuffer(numPoints * 4);
        const gridBuf = this.createUniformBuffer(32, ptr => {
            new Float32Array(ptr, 0, 4).set([grid.min.x, grid.min.y, grid.min.z, grid.unit]);
            new Uint32Array(ptr, 16, 4).set([dims.x, dims.y, dims.z, 0]);
        });
        this.#dispatchKernel(commandEncoder, this.computeCellIxPipeline, [psIn, pixsBuf, cixsBuf, gridBuf], numPoints);

        const radixSort = this.#prepareCachedRadixSortKernel(numPoints, commandEncoder);
        commandEncoder.copyBufferToBuffer(cixsBuf, 0, radixSort.keysBuf, 0, numPoints * 4);
        commandEncoder.copyBufferToBuffer(pixsBuf, 0, radixSort.valuesBuf, 0, numPoints * 4);
        const pass = commandEncoder.beginComputePass();
        radixSort.kernel.dispatch(pass);
        pass.end();
        commandEncoder.copyBufferToBuffer(radixSort.keysBuf, 0, cixsBuf, 0, numPoints * 4);
        commandEncoder.copyBufferToBuffer(radixSort.valuesBuf, 0, pixsBuf, 0, numPoints * 4);

        const beginBuf = this.createBuffer(numCells * 4);
        const endBuf = this.createBuffer(numCells * 4);
        this.#dispatchKernel(commandEncoder, this.clearGroupsPipeline, [beginBuf, endBuf], numCells);
        this.#dispatchKernel(commandEncoder, this.detectGroupsPipeline, [cixsBuf, beginBuf, endBuf], numPoints);

        this.device.queue.submit([commandEncoder.finish()]);

        await this.device.queue.onSubmittedWorkDone();
        return {
            unit: grid.unit,
            gridBuf: gridBuf,
            dims: dims,
            pointsBuf: psIn,
            pixsBuf: pixsBuf,
            beginBuf: beginBuf,
            endBuf: endBuf,
        };
    }

    // Find the closest pair of points between qs and ps, if they're within "unit" given in createGridIndex.
    // Limited to max 1024 points.
    // [in] ps: array<vec4f>
    // [in] qsIndex: opaque index created by createGridIndex
    // returns: [{ix: number, d: number}] (closest first)
    async getClosePoints(ps, qsIndex) {
        // flow: compute min for points in P -> sort by distance (keep ix mapping table) -> read first MAX_READ_NUM entries

        const numPointsP = ps.size / 16;
        const MAX_READ_NUM = 1024;

        const commandEncoder = this.device.createCommandEncoder();

        const distsBuf = this.createBuffer(numPointsP * 4);

        // ps_in: array<vec4<f32>>; // length = number of P points, order = original P point order
        // qs_in: array<vec4<f32>>; // length = number of Q points, order = original Q point order
        // qixs_in: array<u32>; // length = number of Q points, order = sorted cell entry
        // qcgs_begin_in: array<u32>; // length = number of Q cells
        // qcgs_end_in: array<u32>; // length = number of Q cells
        // qgrid: AABBGrid;
        // dists_out: array<u32>; // quantized distance (in 0.1 um; 16bit; truncated to < 6mm), length = number of P points
        this.#dispatchKernel(commandEncoder, this.computeMinsPipeline,
            [ps, qsIndex.pointsBuf, qsIndex.pixsBuf, qsIndex.beginBuf, qsIndex.endBuf, qsIndex.gridBuf, distsBuf],
            numPointsP);
        
        const pixsBuf = this.createBuffer(numPointsP * 4);
        this.#dispatchKernel(commandEncoder, this.populateIxsPipeline, [pixsBuf], numPointsP);

        const radixSort = this.#prepareCachedRadixSortKernel(numPointsP, commandEncoder);
        commandEncoder.copyBufferToBuffer(distsBuf, 0, radixSort.keysBuf, 0, numPointsP * 4);
        commandEncoder.copyBufferToBuffer(pixsBuf, 0, radixSort.valuesBuf, 0, numPointsP * 4);
        const pass = commandEncoder.beginComputePass();
        radixSort.kernel.dispatch(pass);
        pass.end();
        commandEncoder.copyBufferToBuffer(radixSort.keysBuf, 0, distsBuf, 0, numPointsP * 4);
        commandEncoder.copyBufferToBuffer(radixSort.valuesBuf, 0, pixsBuf, 0, numPointsP * 4);

        const readNum = Math.min(MAX_READ_NUM, numPointsP);

        const readDistBuf = this.createBufferForCpuRead(readNum * 4);
        const readPixsBuf = this.createBufferForCpuRead(readNum * 4);
        commandEncoder.copyBufferToBuffer(distsBuf, 0, readDistBuf, 0, readNum * 4);
        commandEncoder.copyBufferToBuffer(pixsBuf, 0, readPixsBuf, 0, readNum * 4);
        this.device.queue.submit([commandEncoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();

        await readDistBuf.mapAsync(GPUMapMode.READ);
        await readPixsBuf.mapAsync(GPUMapMode.READ);
        const distCpuBuf = new Uint32Array(readNum);
        const pixsCpuBuf = new Uint32Array(readNum);
        distCpuBuf.set(new Uint32Array(readDistBuf.getMappedRange(0, readNum * 4)));
        pixsCpuBuf.set(new Uint32Array(readPixsBuf.getMappedRange(0, readNum * 4)));
        readDistBuf.unmap();
        readPixsBuf.unmap();

        const result = [];
        for (let i = 0; i < readNum; i++) {
            const dInt = distCpuBuf[i];
            const d = dInt * 0.1e-3; // convert to mm
            if (d >= qsIndex.unit) {
                break;
            }
            result.push({ix: pixsCpuBuf[i], d});
        }
        return result;
    }

    // Get normals for points in psIndex.
    // [in] psIndex: opaque object created by createGridIndex
    // returns: array<vec4f> normal buf (w=1 is valid normal, 0 if inside volume)
    async getNormals(psIndex) {
        const numPoints = psIndex.pointsBuf.size / 16;
        const normalsBuf = this.createBuffer(numPoints * 16);
        const commandEncoder = this.device.createCommandEncoder();
        this.#dispatchKernel(commandEncoder, this.computeNormalPipeline, [psIndex.pointsBuf, psIndex.pixsBuf, psIndex.beginBuf, psIndex.endBuf, psIndex.gridBuf, normalsBuf], numPoints);
        this.device.queue.submit([commandEncoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();
        return normalsBuf;
    }

    // Mark specified point as dead.
    // [in] ps: array<vec4f>
    // [in] ixs: indices of the points to mark as dead
    async markDead(ps, ixs) {
        ixs.forEach(ix => {
            this.device.queue.writeBuffer(ps, 16 * ix, new Float32Array([0, 0, 0, 0]));
        });
    }
}

const POINTS_PER_MM = 10;

class Simulator {
    constructor(shapeW, shapeT, transW, transT) {
        this.shapeW = shapeW;
        this.shapeT = shapeT;
        this.transW = transW;
        this.transT = transT;

        this.device = null;
        this.solidW = null;
        this.solidT = null;
    }

    // must be called after constuction, before any other methods.
    async initGpu() {
        // Initialize WebGPU
        if (!navigator.gpu) {
            throw new Error('WebGPU not supported');
        }
        const adapter = await navigator.gpu.requestAdapter();
        this.device = await adapter.requestDevice();
        this.kernels = new GpuKernels(this.device);

        // Initialize solids
        this.solidW = await this.kernels.initBox(this.shapeW.sizeLocal, POINTS_PER_MM);
        this.solidT = await this.kernels.initBox(this.shapeT.sizeLocal, POINTS_PER_MM);
        this.solidT = await this.kernels.applyCylinder(this.solidT, 1.5);
    }

    async getRenderingBufferW() {
        return await this._getRenderingBuffer(this.solidW, this.transW);
    }

    async getRenderingBufferT() {
        return await this._getRenderingBuffer(this.solidT, this.transT);
    }

    // Extracts active points for rendering.
    // returns: {pos: Float32Array (V4), normal: Float32Array (V4)} of active points (backed by mapped GPU buffer)
    async _getRenderingBuffer(pointsBuf, trans) {
        const RECON_RADIUS = 2 / POINTS_PER_MM;

        const activePointsBuf = await this.kernels.gatherActive(pointsBuf);
        const activeWorldPointsBuf = await this.kernels.applyTransform(activePointsBuf, trans);

        const aabb = await this.kernels.computeAABB(activeWorldPointsBuf);
        const index = await this.kernels.createGridIndex(activeWorldPointsBuf, {min: aabb.min, max: aabb.max, unit: RECON_RADIUS});
        const normals = await this.kernels.getNormals(index);

        const numActive = activeWorldPointsBuf.size / 16;
        const posStagingBuf = this.kernels.createBufferForCpuRead(numActive * 16);
        const normalStagingBuf = this.kernels.createBufferForCpuRead(numActive * 16);

        const commandEncoder = this.kernels.device.createCommandEncoder();
        commandEncoder.copyBufferToBuffer(activeWorldPointsBuf, 0, posStagingBuf, 0, numActive * 16);
        commandEncoder.copyBufferToBuffer(normals, 0, normalStagingBuf, 0, numActive * 16);
        this.kernels.device.queue.submit([commandEncoder.finish()]);
        await this.kernels.device.queue.onSubmittedWorkDone();
        
        await posStagingBuf.mapAsync(GPUMapMode.READ);
        await normalStagingBuf.mapAsync(GPUMapMode.READ);
        return {
            pos: new Float32Array(posStagingBuf.getMappedRange(), 0, numActive * 4),
            normal: new Float32Array(normalStagingBuf.getMappedRange(), 0, numActive * 4)
        };
    }

    // Remove points from W & T within distance d, with roughly following given removal ratio.
    // d must be "small enough" (compared to point spacing). Otherwise, solid will fracture incorrectly.
    //
    // Was originally: remove points from W & T until the closest point pair pair is further than d.
    // [in] d: distance threshold
    // [in] ratio: ratio in [0, 1] (0: removal happens entirely in W. 1: removal happens entirely in T.)
    async removeClose(d, ratio) {
        let t0; // for performance logging

        t0 = performance.now();
        this.solidW = await this.kernels.gatherActive(this.solidW);
        this.solidT = await this.kernels.gatherActive(this.solidT);
        console.log(`  RC: gather ${performance.now() - t0} ms`);
        
        t0 = performance.now();
        const ptsWWorld = await this.kernels.applyTransform(this.solidW, this.transW);
        const ptsTWorld = await this.kernels.applyTransform(this.solidT, this.transT);
        await this.device.queue.onSubmittedWorkDone();
        console.log(`  RC: transform ${performance.now() - t0} ms`);

        t0 = performance.now();
        const aabbW = await this.kernels.computeAABB(ptsWWorld);
        const aabbT = await this.kernels.computeAABB(ptsTWorld);
        const indexW = await this.kernels.createGridIndex(ptsWWorld, {min: aabbW.min, max: aabbW.max, unit: d});
        const indexT = await this.kernels.createGridIndex(ptsTWorld, {min: aabbT.min, max: aabbT.max, unit: d});
        const closeW = await this.kernels.getClosePoints(ptsWWorld, indexT);
        const closeT = await this.kernels.getClosePoints(ptsTWorld, indexW);
        console.log(`  RC: indexing/gpu-find ${performance.now() - t0} ms`);

        const maxRemove = Math.min(closeW.length, closeT.length);
        const removeW = Math.floor(maxRemove * (1 - ratio));
        const removeT = Math.floor(maxRemove * ratio);
        console.log("  RC/Remove W", removeW, "T", removeT);

        if (removeW == 0 && removeT == 0) {
            return;
        }

        t0 = performance.now();
        this.kernels.markDead(this.solidW, closeW.slice(0, removeW).map(c => c.ix));
        this.kernels.markDead(this.solidT, closeT.slice(0, removeT).map(c => c.ix));
        console.log(`  RC: remove ${performance.now() - t0} ms`);
    }
}

class View3D {
    constructor(simulator) {
        this.simulator = simulator;

        // tool control
        this.toolShape = "cylinder";

        // simulation control
        this.ewr = 50; // %, electrode wear ratio
        this.toolInitX = 0;
        this.toolInitY = 0;
        this.feedDir = 0; // deg; 0=Z-, 90=X+
        this.toolRot = 10; // deg/mm; CCW
        this.feedDist = 15; // mm

        // visualization control
        this.slice = false; // YZ plane
        this.sliceX = 0; // mm

        this.currentSimFeedDist = 0;

        this.init();
        this.setupGui();
    }

    init() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        const aspect = width / height;
        this.camera = new THREE.OrthographicCamera(-30 * aspect, 30 * aspect, 30, -30, -500, 500);
        this.camera.position.x = -8;
        this.camera.position.y = -20;
        this.camera.position.z = 10;
        this.camera.up.set(0, 0, 1);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(width, height);
        this.renderer.setAnimationLoop(() => this.animate());
        this.container = document.getElementById('container');
        this.container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xffffff);

        // Basic lighting setup
        const light = new THREE.AmbientLight(0x404040);
        this.scene.add(light);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(0, 0, 1);
        this.scene.add(directionalLight);

        const hemiLight = new THREE.HemisphereLight(0xffffbb, 0x080820, 1);
        this.scene.add(hemiLight);

        // Add axes helper
        const axesHelper = new THREE.AxesHelper(8);
        this.scene.add(axesHelper);
        axesHelper.position.set(-15, -15, 0);

        // Add grid
        this.gridHelper = new THREE.GridHelper(40, 4);
        this.scene.add(this.gridHelper);
        this.gridHelper.rotateX(Math.PI / 2);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);

        window.addEventListener('resize', () => this.onWindowResize());
        Object.assign(window, { scene: this.scene });

        // Add point cloud visualization
        const pointsMaterialPrototype = new THREE.ShaderMaterial({
            uniforms: {
                use_slice: {value: 0},
                slice_x: {value: 0},
                key_color: {value: new THREE.Color(0.8, 0.8, 0.8)},
                point_size_mm: {value: 1 / POINTS_PER_MM},
                view_height_px: {value: this.renderer.getSize(new THREE.Vector2()).y},
            },
            vertexShader: `
                varying vec4 vert_col;
                varying float slice_dist;

                uniform float use_slice;
                uniform float slice_x;
                uniform vec3 key_color;
                uniform float view_height_px;
                uniform float point_size_mm;

                void main() {
                    slice_dist = abs(position.x - slice_x);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    float f = projectionMatrix[1][1];   // This is ~ 1/tan(fovy/2)

                    float scale = 0.5 * view_height_px * f;
                    float point_size = (scale * point_size_mm) / gl_Position.w;

                    gl_PointSize = point_size * 1.5;
                    bool is_surface = length(normal) > 0.5;

                    if (is_surface) {
                        vec3 light1 = normalize(vec3(-1.0, 0.0, 1.0));
                        vec3 light2 = normalize(vec3(-0.5, -0.5, 0.2));
                        
                        vec3 color1 = vec3(1.0, 0.9, 0.8) * max(dot(normal, light1), 0.0);
                        vec3 color2 = vec3(0.2, 0.3, 0.5) * max(dot(normal, light2), 0.0);
                        vec3 k = 0.2 + color1 * 0.6 + color2 * 0.3; // 0.2 + 0.8 * diffuse; // ambient + diffuse

                        vert_col.xyz = k * key_color.xyz;
                        vert_col.w = 1.0;
                    } else {
                        vert_col.xyz = 0.1 * key_color.xyz;
                        vert_col.w = 1.0;
                    }

                    if (use_slice > 0.5) {
                        float thresh = point_size_mm * 0.75;
                        if (slice_dist > thresh) {
                            vert_col.w = 0.0; // discard in frag shader
                        }
                        if (!is_surface) {
                            gl_PointSize *= 0.1;
                        }
                    }
                }
            `,
            fragmentShader: `
                varying vec4 vert_col;
                varying float slice_dist;
                uniform float point_size_mm;

                void main() {
                    float radius = length(gl_PointCoord - 0.5);
                    if (radius > 0.5) {
                        discard;
                        return;
                    }
                    if (vert_col.w < 0.5) {
                        discard;
                        return;
                    }

                    gl_FragColor = vec4(vert_col.rgb, 1.0);
                }
            `,
        });

        const pointsMaterialW = pointsMaterialPrototype.clone();
        pointsMaterialW.uniforms.key_color.value = new THREE.Color(0.7, 0.7, 1.0);
        const pointsMaterialT = pointsMaterialPrototype.clone();
        pointsMaterialT.uniforms.key_color.value = new THREE.Color(1.0, 0.7, 0.7);

        // Create points geometry for each solid
        this.solidWPoints = new THREE.Points(
            new THREE.BufferGeometry(),
            pointsMaterialW
        );
        this.solidTPoints = new THREE.Points(
            new THREE.BufferGeometry(),
            pointsMaterialT
        );
        // Disable frustum culling, as they have problems when camera is extremely close.
        this.solidWPoints.frustumCulled = false;
        this.solidTPoints.frustumCulled = false;

        this.scene.add(this.solidWPoints);
        this.scene.add(this.solidTPoints);

        // Prepare tool path visualization
        this.toolPathMarkerPos = new THREE.Vector3(1.5 / 2, 0, -5);
        this.updateToolPathVis(this.toolPathMarkerPos, this.feedDist);
    }

    setupGui() {
        const gui = new GUI();

        gui.add(this, "toolShape", ["cylinder", "square"]).name("Tool Shape").onChange(async () => {
            this.simulator.solidT = await this.simulator.kernels.initBox(this.simulator.shapeT.sizeLocal, POINTS_PER_MM);
            if (this.toolShape == "cylinder") {
                this.simulator.solidT = await this.simulator.kernels.applyCylinder(this.simulator.solidT, 1.5);
            }
            this.updatePointsFromGPU();
        });

        const toolPathUpdated = () => {
            this.simulator.transT = this.computeToolTrans(0);
            this.updateToolPathVis(this.toolPathMarkerPos, this.feedDist);
            this.updatePointsFromGPU();
        };
        
        gui.add(this, "toolInitX", -15, 15, 0.1).name("Tool Init X (mm)").onChange(toolPathUpdated);
        gui.add(this, "toolInitY", -15, 15, 0.1).name("Tool Init Y (mm)").onChange(toolPathUpdated);
        gui.add(this, "feedDir", 0, 90, 1).name("Feed Dir (deg)").onChange(toolPathUpdated);
        gui.add(this, "toolRot", 0, 360, 1).name("Tool Rot (deg/mm)").onChange(toolPathUpdated);
        gui.add(this, "ewr", 0, 500, 1).name("E. Wear Ratio (%)");

        gui.add(this, "run");
        gui.add(this, "stop");
        gui.add(this, "currentSimFeedDist").name("Current Feed (mm)").disable().listen();

        gui.add(this, "slice").name("Slice (YZ)").onChange(() => {
            this.solidWPoints.material.uniforms.use_slice.value = this.slice ? 1 : 0;
            this.solidTPoints.material.uniforms.use_slice.value = this.slice ? 1 : 0;
        });
        gui.add(this, "sliceX", -15, 15, 0.1).name("Slice Pos (mm)").onChange(() => {
            this.solidWPoints.material.uniforms.slice_x.value = this.sliceX;
            this.solidTPoints.material.uniforms.slice_x.value = this.sliceX;
        });
    }

    computeToolTrans(feedDist) {
        const pos = new THREE.Vector3(this.toolInitX, this.toolInitY, 6);
        const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), feedDist * this.toolRot * Math.PI / 180);

        const angle = this.feedDir * Math.PI / 180;
        pos.add(new THREE.Vector3(feedDist * Math.sin(angle), 0, -feedDist * Math.cos(angle)));
        return makeTrans(pos, rot);
    }

    updateToolPathVis(initLocPos, distance) {
        const computeToolTrans = (t) => this.computeToolTrans(t * distance);
        class ToolPathCurve extends THREE.Curve {
            getPoint(t, optionalTarget = new THREE.Vector3()) {
                return optionalTarget.copy(initLocPos).applyMatrix4(computeToolTrans(t));
            }
        }
        const vis = new THREE.Mesh(
            new THREE.TubeGeometry(new ToolPathCurve(), 1024, 0.1, 6),
            new THREE.MeshBasicMaterial({color: "darkgray"}));
        
        if (this.toolPathVis) {
            this.scene.remove(this.toolPathVis);
        }
        this.scene.add(vis);
        this.toolPathVis = vis;
        return vis;
    }

    run() {
        this.stopSimulation = false;

        // ewr = 0%: ratio = 0
        // ewr = 100%: ratio = 0.5
        const ewr = this.ewr / 100;
        const ratio = ewr / (1 + ewr);

        const simulateAsync = async () => {
            console.log("simulation start");
            const t0 = performance.now();
            this.currentSimFeedDist = 0;
            while (this.currentSimFeedDist <= this.feedDist) {
                this.simulator.transT = this.computeToolTrans(this.currentSimFeedDist);

                const t0 = performance.now();
                await simulator.removeClose(1 / POINTS_PER_MM, ratio);
                const t1 = performance.now();
                console.log("GPU-removeClose", t1 - t0, "ms");

                await this.updatePointsFromGPU();

                if (this.stopSimulation) {
                    break;
                }

                this.currentSimFeedDist += 0.5 / POINTS_PER_MM; // TODO: this won't work if tool is rotating super fast
            }
            const t1 = performance.now();
            console.log(`Simulate: ${t1 - t0} ms`);
        };

        simulateAsync(); // fire and forget
    }

    stop() {
        this.stopSimulation = true;
    }

    onWindowResize() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        this.renderer.setSize(width, height);
    }

    async updatePointsFromGPU() {
        const pointsW = await this.simulator.getRenderingBufferW();
        const pointsT = await this.simulator.getRenderingBufferT();
        console.log(`Showing W:${pointsW.pos.length / 4} pts, T:${pointsT.pos.length / 4} pts`);

        /*
        const t0 = performance.now();
        const max = new THREE.Vector3(-1e10, -1e10, -1e10);
        const min = new THREE.Vector3(1e10, 1e10, 1e10);
        for (let i = 0; i < pointsW.length / 4; i++) {
            const p = new THREE.Vector3(pointsW[i * 4], pointsW[i * 4 + 1], pointsW[i * 4 + 2]);
            min.min(p);
            max.max(p);
        }
        const t1 = performance.now();
        console.log("CPU-AABB-W", min, max, "took", t1 - t0, "ms");
        */

        this.solidWPoints.geometry.setAttribute('position', new THREE.BufferAttribute(pointsW.pos, 4));
        this.solidWPoints.geometry.setAttribute('normal', new THREE.BufferAttribute(pointsW.normal, 4));
        this.solidTPoints.geometry.setAttribute('position', new THREE.BufferAttribute(pointsT.pos, 4));
        this.solidTPoints.geometry.setAttribute('normal', new THREE.BufferAttribute(pointsT.normal, 4));
    }

    animate() {
        // Update simulation
        try {
            //this.simulator.step(params.timeStep);
        } catch (e) {
            console.warn('Simulation step failed:', e);
        }

        if (!this.gpuIsWorking) {
            this.gpuIsWorking = true;
            this.updatePointsFromGPU();
            //this.gpuIsWorking = false);
        }

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}


////////////////////////////////////////////////////////////////////////////////
// entry point

const makeTrans = (pos, rot) => {
    return new THREE.Matrix4().compose(pos, rot, new THREE.Vector3(1, 1, 1));
};

const simulator = new Simulator(
    new Shape("box", { size: new THREE.Vector3(10, 10, 5) }),
    new Shape("cylinder", { diameter: 1.5, height: 10 }),
    makeTrans(new THREE.Vector3(0, 0, -2.5), new THREE.Quaternion().identity()),
    makeTrans(new THREE.Vector3(0, 0, 6), new THREE.Quaternion().identity())
);

await simulator.initGpu();

const view = new View3D(simulator);
