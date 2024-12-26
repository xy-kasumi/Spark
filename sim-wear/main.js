import * as THREE from 'three';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Units
// distance: mm
// time: sec

// Extended parameters for simulation
const params = {
};

// Represents connected metal.
// Typically used to represent or a tool or a work.
class SolidSpec {
    constructor(center, size, locToWorld = new THREE.Matrix4()) {
        this.center = center;
        this.size = size;
        this.locToWorld = locToWorld;
    }
}

class GpuKernels {
    constructor(device) {
        this.device = device;
        this._compileInit();
        this._compileApplyTransform();
        this._compileComputeAABB();
        this._compileGatherActive();
        this._compileGrid();
    }

    async _debugPrintBuffer(mark, buf) {
        const SIZE_LIMIT = 128;
        const size = Math.min(buf.size, SIZE_LIMIT);

        let usage = buf.usage;
        const usageStrs = [];
        if (usage & GPUBufferUsage.MAP_READ) {
            usageStrs.push("MAP_READ");
            usage &= ~GPUBufferUsage.MAP_READ;
        }
        if (usage & GPUBufferUsage.MAP_WRITE) {
            usageStrs.push("MAP_WRITE");
            usage &= ~GPUBufferUsage.MAP_WRITE;
        }
        if (usage & GPUBufferUsage.COPY_DST) {
            usageStrs.push("COPY_DST");
            usage &= ~GPUBufferUsage.COPY_DST;
        }
        if (usage & GPUBufferUsage.COPY_SRC) {
            usageStrs.push("COPY_SRC");
            usage &= ~GPUBufferUsage.COPY_SRC;
        }
        if (usage & GPUBufferUsage.UNIFORM) {
            usageStrs.push("UNIFORM");
            usage &= ~GPUBufferUsage.UNIFORM;
        }
        if (usage & GPUBufferUsage.STORAGE) {
            usageStrs.push("STORAGE");
            usage &= ~GPUBufferUsage.STORAGE;
        }
        if (usage) {
            usageStrs.push(`${usage.toString(16)}`);
        }

        // Somehow copy to cpu buffer
        const dumpString = `${mark}:Buffer label=${buf.label} size=${buf.size} usage=${usageStrs.join("|")} map=${buf.mapState}`;
        if (buf.usage & GPUBufferUsage.COPY_SRC) {
            // copiable
            const debugBuffer = this.device.createBuffer({
                size: 128,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            });
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

    _compileInit() {
        const cs = this.device.createShaderModule({
            code: `
                @group(0) @binding(0) var<storage, read_write> points: array<vec4f>;
                
                struct Params {
                    center: vec4f,
                    size: vec4f,
                    pointsPerAxis: vec4u,
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
                    
                    let z = index / (params.pointsPerAxis.x * params.pointsPerAxis.y);
                    let y = (index % (params.pointsPerAxis.x * params.pointsPerAxis.y)) / params.pointsPerAxis.x;
                    let x = index % params.pointsPerAxis.x;

                    let pos_normalized = vec3f(
                        f32(x) / f32(params.pointsPerAxis.x),
                        f32(y) / f32(params.pointsPerAxis.y),
                        f32(z) / f32(params.pointsPerAxis.z)
                    );

                    var pos_local = pos_normalized * params.size.xyz - params.size.xyz/2.0 + params.center.xyz;
                    let lattice_d = params.size.x / f32(params.pointsPerAxis.x);

                    // add random noise to remove grid anisotropy
                    pos_local +=
                        (vec3f(
                            rand01(u32(index), 0xca272690),
                            rand01(u32(index), 0xb8100b94),
                            rand01(u32(index), 0x13941583)
                        ) - 0.5) * lattice_d;

                    let pt_active = length(pos_local) < 5.0;

                    points[index] = vec4f(pos_local, select(0.0, 1.0, pt_active));
                }
            `
        });
        this.initPipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.device.createBindGroupLayout({
                    entries: [
                        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
                    ]
                })]
            }),
            compute: { module: cs, entryPoint: "init" }
        });
    }

    // Initialize point cloud.
    // [out] psOut: array<vec4f>
    // [in] center: THREE.Vector3
    // [in] size: THREE.Vector3
    // [in] pointsPerAxis: THREE.Vector3
    init(psOut, center, size, pointsPerAxis) {
        const paramBuf = this.device.createBuffer({
            size: 48, // 3 vec3f (12 bytes each) + 1 vec3u (12 bytes) = 48 bytes
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Float32Array(paramBuf.getMappedRange(0, 32)).set([
            center.x, center.y, center.z, 0,
            size.x, size.y, size.z, 0,
        ]);
        new Uint32Array(paramBuf.getMappedRange(32)).set([
            pointsPerAxis.x, pointsPerAxis.y, pointsPerAxis.z, 0,
        ]);
        paramBuf.unmap();

        const numPoints = pointsPerAxis.x * pointsPerAxis.y * pointsPerAxis.z;

        const bindGroup = this.device.createBindGroup({
            layout: this.initPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: psOut } },
                { binding: 1, resource: { buffer: paramBuf } },
            ]
        });

        const commandEncoder = this.device.createCommandEncoder();
        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(this.initPipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.dispatchWorkgroups(Math.ceil(numPoints / 128));
        passEncoder.end();
        this.device.queue.submit([commandEncoder.finish()]);
    }

    _compileApplyTransform() {
        const cs = this.device.createShaderModule({
            code: `
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
                    let p_new = transform * p;
                    ps_out[index] = vec4f(p_new.xyz, p.w);
                }
        `});

        this.applyTransformPipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.device.createBindGroupLayout({
                    entries: [
                        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
                    ]
                })]
            }),
            compute: { module: cs, entryPoint: "apply_transform" }
        });
    }

    // Initialize point cloud. In psIn and return value, w is 1 if alive, 0 if dead.
    // [in] psIn: array<vec4f>
    // [in] locToWorld: THREE.Matrix4
    // [in] numPoints: number
    // returns: array<vec4f> (same order & length as psIn)
    applyTransform(psIn, locToWorld, numPoints) {
        const psOut = this.device.createBuffer({
            label: "ps-out-at",
            size: numPoints * 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        const matBuf = this.device.createBuffer({
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Float32Array(matBuf.getMappedRange(0, 64)).set(locToWorld.clone().transpose().elements); // row-major to col-major
        matBuf.unmap();

        const bindGroup = this.device.createBindGroup({
            layout: this.applyTransformPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: psIn } },
                { binding: 1, resource: { buffer: psOut } },
                { binding: 2, resource: { buffer: matBuf } },
            ]
        });

        const commandEncoder = this.device.createCommandEncoder();
        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(this.applyTransformPipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.dispatchWorkgroups(Math.ceil(numPoints / 128));
        passEncoder.end();
        this.device.queue.submit([commandEncoder.finish()]);

        return psOut;
    }

    
    _compileComputeAABB() {
        const cs = this.device.createShaderModule({
            code: `
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
        `});

        this.computeAABBPipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.device.createBindGroupLayout({
                    entries: [
                        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                    ]
                })]
            }),
            compute: { module: cs, entryPoint: "reduce_aabb" }
        });
    }

    // Initialize point cloud. In psIn and return value, w is 1 if alive, 0 if dead.
    // [in] ps: array<vec4f>
    // [in] numPoints: number
    // returns: {min: THREE.Vector3, max: THREE.Vector3}
    async computeAABB(ps, numPoints) {
        const temp0Min = this.device.createBuffer({label: "t0min", size: numPoints * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
        const temp0Max = this.device.createBuffer({label: "t0max", size: numPoints * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
        const temp1Min = this.device.createBuffer({label: "t1min", size: numPoints * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
        const temp1Max = this.device.createBuffer({label: "t1max", size: numPoints * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
        const readBuf = this.device.createBuffer({
            label: "read",
            size: 16 * 2, // min & max
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });

        const commandEncoder = this.device.createCommandEncoder();
            
        commandEncoder.copyBufferToBuffer(ps, 0, temp0Min, 0, numPoints * 16);
        commandEncoder.copyBufferToBuffer(ps, 0, temp0Max, 0, numPoints * 16);

        let currentNumPoints = numPoints;
        let mode0to1 = true;
        while (currentNumPoints > 1) {
            const bindGroup = this.device.createBindGroup({
                layout: this.computeAABBPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: mode0to1 ? temp0Min : temp1Min } },
                    { binding: 1, resource: { buffer: mode0to1 ? temp0Max : temp1Max } },
                    { binding: 2, resource: { buffer: mode0to1 ? temp1Min : temp0Min } },
                    { binding: 3, resource: { buffer: mode0to1 ? temp1Max : temp0Max } },
                ]
            });

            const passEncoder = commandEncoder.beginComputePass();
            passEncoder.setPipeline(this.computeAABBPipeline);
            passEncoder.setBindGroup(0, bindGroup);
            passEncoder.dispatchWorkgroups(Math.floor(currentNumPoints / 128) + 1);
            passEncoder.end();

            mode0to1 = !mode0to1;
            currentNumPoints = Math.floor(currentNumPoints / 128) + 1;
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

    _compileGatherActive() {
        const cs = this.device.createShaderModule({
            code: `
                @group(0) @binding(0) var<storage, read_write> psIn: array<vec4<f32>>;
                @group(0) @binding(1) var<storage, read_write> psOut: array<vec4<f32>>;
                @group(0) @binding(2) var<storage, read_write> counter: atomic<u32>;

                @compute @workgroup_size(128)
                fn gatherActive(@builtin(global_invocation_id) gid: vec3<u32>) {
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
        });
        this.gatherActivePipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.device.createBindGroupLayout({
                    entries: [
                        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                    ]
                })]
            }),
            compute: { module: cs, entryPoint: "gatherActive" },
        });
    }

    // Gather active points from psIn and store them continuously from the beginning of psOut.
    // [in] psIn: array<vec4f>
    // [out] psOut: array<vec4f>
    // [in] numPoints: number
    // returns: the number of active points
    async gatherActive(psIn, psOut, numPoints) {
        const countBuf = this.device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "countBuf",
        });
        const countBufReading = this.device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            label: "countBufReading",
        });

        const bindGroup = this.device.createBindGroup({
            layout: this.gatherActivePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: psIn } },
                { binding: 1, resource: { buffer: psOut } },
                { binding: 2, resource: { buffer: countBuf } },
            ]
        });

        this.device.queue.writeBuffer(countBuf, 0, new Uint32Array([0]));

        const commandEncoder = this.device.createCommandEncoder();
        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(this.gatherActivePipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.dispatchWorkgroups(Math.ceil(numPoints / 128));
        passEncoder.end();
        commandEncoder.copyBufferToBuffer(countBuf, 0, countBufReading, 0, 4);
        this.device.queue.submit([commandEncoder.finish()]);

        await countBufReading.mapAsync(GPUMapMode.READ);
        const count = new Uint32Array(countBufReading.getMappedRange(0, 4))[0];
        countBufReading.unmap();

        return count;
    }

    _compileGrid() {
        const cs = this.device.createShaderModule({
            code: `
                struct CellEntry {
                    cellIx: u32,
                    pointIx: u32,
                    exists: u32, // 1 if exists, 0 if not
                }
                
                struct AABBGrid {
                    min: vec4f,
                    size: vec4u,
                    dist: f32,
                }
                
                @group(0) @binding(0) var<storage, read_write> psIn: array<vec4<f32>>;
                @group(0) @binding(1) var<storage, read_write> entries: array<CellEntry>;
                @group(0) @binding(2) var<uniform> grid: AABBGrid;

                @compute @workgroup_size(128)
                fn computeCellIx(@builtin(global_invocation_id) gid: vec3<u32>) {
                    let p = psIn[gid.x];
                    if (p.w < 0.5) {
                        entries[gid.x] = CellEntry(0, 0, 0u);
                        return; // non-existent
                    }

                    let ixs = vec3u(floor((p.xyz - grid.min.xyz) / grid.dist));
                    let cell_ix = ixs.x + ixs.y * grid.size.x + ixs.z * grid.size.x * grid.size.y;

                    entries[gid.x] = CellEntry(cell_ix, gid.x, 1u);
                }
            `
        });
        this.computeCellIxPipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.device.createBindGroupLayout({
                    entries: [
                        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
                    ]
                })]
            }),
            compute: { module: cs, entryPoint: "computeCellIx" },
        });
    }

    computeCellIx(psIn, entries, grid) {

    }

    
}

class GpuSolid {
    // Initializes a rectangular solid with a given center, size, and transform.
    constructor(kernels, spec) {
        this.kernels = kernels;
        this.spec = spec;

        // compute num points & buffer structure.
        const POINT_PER_MM = 5;
        this.pointsPerAxis = spec.size.clone().multiplyScalar(POINT_PER_MM).floor();
        this.numPoints = this.pointsPerAxis.x * this.pointsPerAxis.y * this.pointsPerAxis.z;
        console.log(this.numPoints, this.pointsPerAxis);

        // Allocate buffers.

        // XYZ: position
        // Z: 1 (active), 0 (inactive)
        this.pointsBuffer = kernels.device.createBuffer({
            size: this.numPoints * 4 * Float32Array.BYTES_PER_ELEMENT,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        // XYZ: position, W: 1
        this.stagingBuffer = kernels.device.createBuffer({
            size: this.numPoints * 4 * Float32Array.BYTES_PER_ELEMENT,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });

        this.kernels.init(this.pointsBuffer, spec.center, spec.size, this.pointsPerAxis);
    }

    // Populates this.stagingBuffer with active points.
    // returns: number of active points
    async copyToStagingBuffer() {
        const tempBuffer = this.kernels.device.createBuffer({
            size: this.numPoints * 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        const numActive = await this.kernels.gatherActive(this.pointsBuffer, tempBuffer, this.numPoints);

        this.stagingBuffer.unmap();
        {
            const commandEncoder = this.kernels.device.createCommandEncoder();
            commandEncoder.copyBufferToBuffer(tempBuffer, 0, this.stagingBuffer, 0, tempBuffer.size);
            this.kernels.device.queue.submit([commandEncoder.finish()]);
        }
        await this.stagingBuffer.mapAsync(GPUMapMode.READ);

        return numActive;
    }
}

class Simulator {
    constructor(solidSpecW, solidSpecT) {
        this.solidSpecW = solidSpecW;
        this.solidSpecT = solidSpecT;
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
        this.solidW = new GpuSolid(this.kernels, this.solidSpecW);
        this.solidT = new GpuSolid(this.kernels, this.solidSpecT);

        await this.device.queue.onSubmittedWorkDone();
    }

    // Remove points from W & T until the closest point pair pair is further than d.
    // [in] d: distance threshold
    // [in] ratio: ratio in [0, 1] (0: removal happens entirely in W. 1: removal happens entirely in T.)
    async removeClose(d, ratio) {
        const pointsWWorld = this.kernels.applyTransform(this.solidW.pointsBuffer, this.solidSpecW.locToWorld, this.solidW.numPoints);
        const pointsTWorld = this.kernels.applyTransform(this.solidT.pointsBuffer, this.solidSpecT.locToWorld, this.solidT.numPoints);

        // We assume W is generally bigger than T. That's why we create for grid for W, instead of T.
        const t0 = performance.now();
        const aabbW = await this.kernels.computeAABB(this.solidW.pointsBuffer, this.solidW.numPoints);
        const t1 = performance.now();   
        console.log("AABB W", aabbW, "took", t1 - t0, "ms");
        return;

        const gridW = {
            min: aabbW.min,
            unit: d,
            dims: aabbW.size.clone().divideScalar(d).floor().addScalar(1),
        };
        const cellEntriesW = this.kernels.computeCellIx(pointsWWorld, gridW);
        const cellsW = this.kernels.sortCellEntries(cellEntriesW);

        while (true) {
            const minPair = this.kernels.findMinPair(pointsTWorld, cellsW, d);
            if (minPair.dist >= d) {
                return;
            }
    
            // Remove a point from W or T.
            if (Math.random() > ratio) {
                this.kernels.markDead(this.solidW.pointsBuffer, minPair.ixW);
            } else {
                this.kernels.markDead(this.solidT.pointsBuffer, minPair.ixT);
            }
        }
    }
}

class View3D {
    constructor(simulator) {
        this.simulator = simulator;
        this.init();
        this.setupGui();
    }

    init() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        const aspect = width / height;
        this.camera = new THREE.OrthographicCamera(-50 * aspect, 50 * aspect, 50, -50, -500, 500);
        this.camera.position.x = -15;
        this.camera.position.y = -40;
        this.camera.position.z = 20;
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
        axesHelper.position.z += 0.01; // increase visibility

        // Add grid
        this.gridHelper = new THREE.GridHelper(100, 10);
        this.scene.add(this.gridHelper);
        this.gridHelper.rotateX(Math.PI / 2);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);

        window.addEventListener('resize', () => this.onWindowResize());
        Object.assign(window, { scene: this.scene });

        // Add point cloud visualization
        const pointsMaterialW = new THREE.PointsMaterial({
            size: 2,
            sizeAttenuation: true,
            color: "blue"
        });
        const pointsMaterialT = new THREE.PointsMaterial({
            size: 2,
            sizeAttenuation: true,
            color: "red"
        });

        // Create points geometry for each solid
        this.solidWPoints = new THREE.Points(
            new THREE.BufferGeometry(),
            pointsMaterialW
        );
        this.solidTPoints = new THREE.Points(
            new THREE.BufferGeometry(),
            pointsMaterialT
        );

        this.scene.add(this.solidWPoints);
        this.scene.add(this.solidTPoints);
    }

    setupGui() {
        const gui = new GUI();
    }

    onWindowResize() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        this.renderer.setSize(width, height);
    }

    async updatePointsFromGPU() {
        const numActiveW = await this.simulator.solidW.copyToStagingBuffer();
        const numActiveT = await this.simulator.solidT.copyToStagingBuffer();
        console.log(`W:${numActiveW} pts, T:${numActiveT} pts`);

        const solidWData = new Float32Array(this.simulator.solidW.stagingBuffer.getMappedRange(), 0, numActiveW * 4);
        const solidTData = new Float32Array(this.simulator.solidT.stagingBuffer.getMappedRange(), 0, numActiveT * 4);

        console.log(solidWData, solidWData.length);
        console.log(solidTData, solidTData.length);

        const t0 = performance.now();
        const max = new THREE.Vector3(-1e10, -1e10, -1e10);
        const min = new THREE.Vector3(1e10, 1e10, 1e10);
        for (let i = 0; i < numActiveW; i++) {
            const p = new THREE.Vector3(solidWData[i * 4], solidWData[i * 4 + 1], solidWData[i * 4 + 2]);
            min.min(p);
            max.max(p);
        }
        const t1 = performance.now();
        console.log("CPU-AABB-W", min, max, "took", t1 - t0, "ms");

        this.solidWPoints.geometry.setAttribute('position', new THREE.BufferAttribute(solidWData, 4));
        this.solidTPoints.geometry.setAttribute('position', new THREE.BufferAttribute(solidTData, 4));
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

const solidSpecW = new SolidSpec(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(10, 10, 10),
    new THREE.Matrix4().identity()
);

const solidSpecT = new SolidSpec(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(3, 3, 10),
    new THREE.Matrix4().identity().makeTranslation(5, -8, 0),
);

const simulator = new Simulator(solidSpecW, solidSpecT);
await simulator.initGpu();
await simulator.removeClose(0.5, 0.5);


const view = new View3D(simulator);
