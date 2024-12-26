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

    async _readAllV4(buf) {
        const numVecs = buf.size / 16;
        const tempBuffer = this.device.createBuffer({
            size: numVecs * 16,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
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

    _compileInit() {
        const cs = this.device.createShaderModule({
            code: `
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
                        rand01(u32(index), 0x13941583));

                    let pos_local = 
                        params.size.xyz +
                        (vec3f(f32(x), f32(y), f32(z)) + noise) * params.size.w;
                    points[index] = vec4f(pos_local, 1);
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
    // [in] size: THREE.Vector3
    // [in] pointsPerMm: number
    // returns: buffer (vec4)
    async initBox(size, pointsPerMm) {
        const pointsPerAxis = size.clone().multiplyScalar(pointsPerMm).ceil();
        const numPoints = pointsPerAxis.x * pointsPerAxis.y * pointsPerAxis.z;
        const minPoint = size.clone().multiplyScalar(-0.5);

        const pointsBuf = this.device.createBuffer({
            size: numPoints * 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });

        const paramBuf = this.device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Float32Array(paramBuf.getMappedRange(0, 16)).set([
            minPoint.x, minPoint.y, minPoint.z, 1 / pointsPerMm,
        ]);
        new Uint32Array(paramBuf.getMappedRange(16, 16)).set([
            pointsPerAxis.x, pointsPerAxis.y, pointsPerAxis.z, 0,
        ]);
        paramBuf.unmap();

        const bindGroup = this.device.createBindGroup({
            layout: this.initPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: pointsBuf } },
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
        await this.device.queue.onSubmittedWorkDone();

        return pointsBuf;
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
                    let p_new = (transform * vec4f(p.xyz, 1)).xyz;
                    ps_out[index] = vec4f(p_new, p.w);
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
    // returns: array<vec4f> (same order & length as psIn)
    applyTransform(psIn, locToWorld) {
        const numPoints = psIn.size / 16;
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
        // col-major -> col-major (cf. https://threejs.org/docs/?q=Matrix#api/en/math/Matrix4.compose)
        new Float32Array(matBuf.getMappedRange(0, 64)).set(locToWorld.elements);
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
            passEncoder.dispatchWorkgroups(Math.ceil(currentNumPoints / 128));
            passEncoder.end();

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

    // Gather active points from psIn.
    // [in] psIn: array<vec4f>
    // returns: new buffer
    async gatherActive(psIn) {
        const numPoints = psIn.size / 16;

        const tempBuf = this.device.createBuffer({
            size: numPoints * 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: "tempBuf",
        });
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
                { binding: 1, resource: { buffer: tempBuf } },
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

        // copy to new smaller buffer
        const resultBuffer = this.device.createBuffer({
            size: count * 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        {
            const commandEncoder = this.device.createCommandEncoder();
            commandEncoder.copyBufferToBuffer(tempBuf, 0, resultBuffer, 0, count * 16);
            this.device.queue.submit([commandEncoder.finish()]);
            await this.device.queue.onSubmittedWorkDone();
        }
        return resultBuffer;
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

                @compute @workgroup_size(128)
                fn mapMin(@builtin(global_invocation_id) gid: vec3<u32>) {
                    let p = psIn[gid.x];

                    // find 3D cellIndex
                    // loop 27 neighbor cell index
                    // continue if cell does not exist (out of range)
                    // if cell exist, lookup cell entry table (beginIx, endIx)
                    // loop through beginIx, endIx
                    // lookup point position, compute distance, compute local min
                    // write local min to buffer
                }

                @compute @workgroup_size(128)
                fn reduceMin() {
                    // normal parallel reduction
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

    // Create a grid index.
    // [in] psIn: array<vec4f>
    // [in] numPoints: number of points in psIn
    // [in] grid: {min: THREE.Vector3, unit: number cell size, dims: THREE.Vector3 number of cells per axis}
    //    unit is also the max distance that can be queried by findMinPair.
    // returns: some opaque object that can be passed to findMinPair
    async createGridIndex(psIn, numPoints, grid) {
        //const psIn = await this._readAllV4(psIn);
        return {};
    }

    // Find the closest pair of points between qs and ps, if they're within "unit" given in createGridIndex.
    // [in] ps: array<vec4f>
    // [in] numPs: number of points in ps
    // [in] qsIndex: opaque index created by createGridIndex
    // returns: {pIx: number, qIx: number, dist: number} | null (if not found)
    async findMinPair(ps, numPs, qsIndex) {
        return {pIx: 0, qIx: 0, dist: 0};
    }

    // Mark specified point as dead.
    // [in] ps: array<vec4f>
    // [in] ix: index of the point to mark as dead
    async markDead(ps, ix) {
        this.device.queue.writeBuffer(ps, 16 * ix, new Float32Array([0, 0, 0, 0]));
    }
}

const POINT_PER_MM = 4;

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
        this.solidW = await this.kernels.initBox(this.shapeW.sizeLocal, POINT_PER_MM);
        this.solidT = await this.kernels.initBox(this.shapeT.sizeLocal, POINT_PER_MM);
    }

    async getRenderingBufferW() {
        return await this._getRenderingBuffer(this.solidW, this.transW);
    }

    async getRenderingBufferT() {
        return await this._getRenderingBuffer(this.solidT, this.transT);
    }

    // Extracts active points for rendering.
    // returns: Float32Array of active points (backed by mapped GPU buffer)
    async _getRenderingBuffer(pointsBuf, trans) {
        const activePointsBuf = await this.kernels.gatherActive(pointsBuf);
        const activeWorldPointsBuf = await this.kernels.applyTransform(activePointsBuf, trans);

        const numActive = activeWorldPointsBuf.size / 16;
        const stagingBuffer = this.kernels.device.createBuffer({
            size: numActive * 16,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        const commandEncoder = this.kernels.device.createCommandEncoder();
        commandEncoder.copyBufferToBuffer(activeWorldPointsBuf, 0, stagingBuffer, 0, stagingBuffer.size);
        this.kernels.device.queue.submit([commandEncoder.finish()]);
        await this.kernels.device.queue.onSubmittedWorkDone();
        
        await stagingBuffer.mapAsync(GPUMapMode.READ);
        return new Float32Array(stagingBuffer.getMappedRange(), 0, numActive * 4);
    }

    // Remove points from W & T until the closest point pair pair is further than d.
    // [in] d: distance threshold
    // [in] ratio: ratio in [0, 1] (0: removal happens entirely in W. 1: removal happens entirely in T.)
    async removeClose(d, ratio) {
        // We assume W is generally bigger than T. That's why we create for grid for W, instead of T.
        /*
        const aabbW = await this.kernels.computeAABB(pointsWWorld, this.solidW.numPoints);
        console.log("AABB W", aabbW);

        const gridW = {
            min: aabbW.min,
            unit: d,
            dims: aabbW.max.clone().sub(aabbW.min).divideScalar(d).floor().addScalar(1),
        };
        const wIndex = this.kernels.createGridIndex(pointsWWorld, this.solidW.numPoints, gridW);
        */

        while (true) {
            const t0 = performance.now();
            const ptsWWorld = this.kernels.applyTransform(this.solidW, this.transW);
            const ptsTWorld = this.kernels.applyTransform(this.solidT, this.transT);

            const wps = await this.kernels._readAllV4(ptsWWorld);
            const tps = await this.kernels._readAllV4(ptsTWorld);

            const minPair = {ixW: null, ixT: null, d: 1e10};
            for (let iw = 0; iw < wps.length; iw++) {
                if (wps[iw].w < 0.5) {
                    continue;
                }
                const vw = new THREE.Vector3(wps[iw].x, wps[iw].y, wps[iw].z);
                for (let it = 0; it < tps.length; it++) {
                    if (tps[it].w < 0.5) {
                        continue;
                    }
                    const vt = new THREE.Vector3(tps[it].x, tps[it].y, tps[it].z);

                    const dist = vt.distanceTo(vw);
                    if (dist < minPair.d) {
                        minPair.d = dist;
                        minPair.ixW = iw;
                        minPair.ixT = it;
                    }
                }
            }
            const t1 = performance.now();
            console.log("CPU-min", t1 - t0, "ms");
            //const minPair = this.kernels.findMinPair(pointsTWorld, this.solidT.numPoints, wIndex);
            console.log("Min pair", minPair);
            if (minPair.d > d) {
                console.log("Too far, stopping");
                break;
            }

            // Remove a point from W or T.
            if (Math.random() > ratio) {
                console.log("Removing W point");
                this.kernels.markDead(this.solidW, minPair.ixW);
            } else {
                console.log("Removing T point");
                this.kernels.markDead(this.solidT, minPair.ixT);
            }
        }
    }
}

class View3D {
    constructor(simulator) {
        this.simulator = simulator;

        this.ewr = 50; // %, electrode wear ratio
        this.toolInitX = 0;
        this.toolInitY = 0;
        this.feedDir = 0; // deg; 0=Z-, 90=X+
        this.toolRot = 10; // deg/mm; CCW
        this.feedDist = 15; // mm

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

        // Prepare tool path visualization
        this.toolPathMarkerPos = new THREE.Vector3(1.5 / 2, 0, -5);
        this.updateToolPathVis(this.toolPathMarkerPos, this.feedDist);
    }

    setupGui() {
        const gui = new GUI();

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

        gui.add(this, "runSingle");
        gui.add(this, "run");
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

    runSingle() {
        console.log("runSingle");

        // ewr = 0%: ratio = 0
        // ewr = 100%: ratio = 0.5
        const ewr = this.ewr / 100;
        const ratio = ewr / (1 + ewr);

        const updatePoints = async () => {
            const t0 = performance.now();
            await simulator.removeClose(1.5, ratio);
            const t1 = performance.now();
            console.log("GPU-removeClose", t1 - t0, "ms");

            await this.updatePointsFromGPU();
        };

        updatePoints(); // fire and forget
    }

    run() {
        console.log("run");
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
        console.log(`W:${pointsW.length / 4} pts, T:${pointsT.length / 4} pts`);

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

        this.solidWPoints.geometry.setAttribute('position', new THREE.BufferAttribute(pointsW, 4));
        this.solidTPoints.geometry.setAttribute('position', new THREE.BufferAttribute(pointsT, 4));
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
await simulator.removeClose(0.5, 0.5); // TODO: remove later after debug is done

const view = new View3D(simulator);
