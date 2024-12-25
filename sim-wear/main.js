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
    constructor(center, size, transform = new THREE.Matrix4()) {
        this.center = center;
        this.size = size;
        this.transform = transform;
    }
}

class GpuSolid {
    // Initializes a rectangular solid with a given center, size, and transform.
    constructor(device, spec) {
        this.device = device;
        this.sepc = spec;

        // compute num points & buffer structure.
        const POINT_PER_MM = 3;
        this.pointsPerAxis = spec.size.clone().multiplyScalar(POINT_PER_MM).floor();
        this.numPoints = this.pointsPerAxis.x * this.pointsPerAxis.y * this.pointsPerAxis.z;
        console.log(this.numPoints, this.pointsPerAxis);

        // Allocate buffers.
        this.gpuBuffer = this.device.createBuffer({
            size: this.numPoints * 4 * Float32Array.BYTES_PER_ELEMENT,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        this.stagingBuffer = this.device.createBuffer({
            size: this.numPoints * 4 * Float32Array.BYTES_PER_ELEMENT,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });

        this.uniformBuffer = this.device.createBuffer({
            size: 48, // 3 vec3f (12 bytes each) + 1 vec3u (12 bytes) = 48 bytes
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Float32Array(this.uniformBuffer.getMappedRange(0, 32)).set([
            spec.center.x, spec.center.y, spec.center.z, 0,
            spec.size.x, spec.size.y, spec.size.z, 0,
        ]);
        new Uint32Array(this.uniformBuffer.getMappedRange(32)).set([
            this.pointsPerAxis.x, this.pointsPerAxis.y, this.pointsPerAxis.z, 0,
        ]);
        this.uniformBuffer.unmap();

        this._initializeGPU();
    }

    _initializeGPU() {
        // Create compute shader to generate points
        const computeShader = this.device.createShaderModule({
            code: `
                @group(0) @binding(0) var<storage, read_write> points: array<vec4f>;
                
                struct Params {
                    center: vec4f,
                    size: vec4f,
                    pointsPerAxis: vec4u,
                }
                @group(0) @binding(1) var<uniform> params: Params;

                @compute @workgroup_size(64)
                fn main(@builtin(global_invocation_id) id: vec3u) {
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

                    let pos_local = pos_normalized * params.size.xyz - params.size.xyz/2.0 + params.center.xyz;
                    points[index] = vec4f(pos_local, 1.0);
                }
            `
        });

        // Create pipeline and bind group
        const pipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.device.createBindGroupLayout({
                    entries: [
                        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
                    ]
                })]
            }),
            compute: { module: computeShader, entryPoint: "main" }
        });
        this.pipeline = pipeline;

        const bindGroup = this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.gpuBuffer } },
                { binding: 1, resource: { buffer: this.uniformBuffer } },
            ]
        });

        // Execute compute shader
        const commandEncoder = this.device.createCommandEncoder();
        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.dispatchWorkgroups(Math.ceil(this.numPoints / 64));
        passEncoder.end();
        this.device.queue.submit([commandEncoder.finish()]);
    }

    async copyToStagingBuffer() {
        this.stagingBuffer.unmap();

        const commandEncoder = this.device.createCommandEncoder();
        commandEncoder.copyBufferToBuffer(this.gpuBuffer, 0, this.stagingBuffer, 0, this.gpuBuffer.size);
        this.device.queue.submit([commandEncoder.finish()]);

        await this.stagingBuffer.mapAsync(GPUMapMode.READ);
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

        // Initialize solids
        this.solidW = new GpuSolid(this.device, this.solidSpecW);
        this.solidT = new GpuSolid(this.device, this.solidSpecT);
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
            color: "red"
        });
        const pointsMaterialT = new THREE.PointsMaterial({
            size: 2,
            sizeAttenuation: true,
            color: "blue"
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
        await this.simulator.solidW.copyToStagingBuffer();
        await this.simulator.solidT.copyToStagingBuffer();

        const solidWData = new Float32Array(this.simulator.solidW.stagingBuffer.getMappedRange());
        const solidTData = new Float32Array(this.simulator.solidT.stagingBuffer.getMappedRange());

        console.log(solidWData, solidWData.length);
        console.log(solidTData, solidTData.length);

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


const view = new View3D(simulator);
