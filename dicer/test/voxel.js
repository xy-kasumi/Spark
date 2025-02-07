import { Vector3 } from 'three';
import { createBoxShape, createCylinderShape, createELHShape, createSdf, uberSdfSnippet, uberSdfUniformDefs, uberSdfUniformVars, GpuKernels, VoxelGridCpu, VoxelGridGpu } from '../voxel.js';

QUnit.module('cpu-sdf', function () {
    QUnit.test('sdf cube', function (assert) {
        // create box [0,1]^3.
        const shape = createBoxShape(new Vector3(0.5, 0.5, 0.5), new Vector3(0.5, 0, 0), new Vector3(0, 0.5, 0), new Vector3(0, 0, 0.5));
        const sdf = createSdf(shape);

        assert.equal(sdf(new Vector3(0, 0, 0)), 0, "corner");
        assert.equal(sdf(new Vector3(0, 0, 1)), 0, "corner");
        assert.equal(sdf(new Vector3(0, 1, 0)), 0, "corner");
        assert.equal(sdf(new Vector3(0, 1, 1)), 0, "corner");
        assert.equal(sdf(new Vector3(1, 0, 0)), 0, "corner");
        assert.equal(sdf(new Vector3(1, 0, 1)), 0, "corner");
        assert.equal(sdf(new Vector3(1, 1, 0)), 0, "corner");
        assert.equal(sdf(new Vector3(1, 1, 1)), 0, "corner");
        assert.equal(sdf(new Vector3(0.5, 0.5, 0.5)), -0.5, "center");

        // Scan along X-axis at (Y,Z) = (0.5,1.5)
        assert.equal(sdf(new Vector3(-1, 0.5, 1.5)), Math.hypot(-1, 0.5));
        assert.equal(sdf(new Vector3(-0.5, 0.5, 1.5)), Math.hypot(-0.5, 0.5));
        assert.equal(sdf(new Vector3(0, 0.5, 1.5)), 0.5);
        assert.equal(sdf(new Vector3(0.5, 0.5, 1.5)), 0.5);
        assert.equal(sdf(new Vector3(1, 0.5, 1.5)), 0.5);
        assert.equal(sdf(new Vector3(1.5, 0.5, 1.5)), Math.hypot(0.5, 0.5));
    });

    QUnit.test('sdf box', function (assert) {
        const shape = createBoxShape(new Vector3(0, 0, 0), new Vector3(0.5, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1.5));
        const sdf = createSdf(shape);
        assert.equal(sdf(new Vector3(0, 0, 0)), -0.5, "center");
        assert.equal(sdf(new Vector3(-0.5, 0, 0)), 0, "X-");
        assert.equal(sdf(new Vector3(0, -1, 0)), 0, "Y-");
        assert.equal(sdf(new Vector3(0, 0, -1.5)), 0, "Z-");
    });

    QUnit.test('sdf cylinder', function (assert) {
        const shape = createCylinderShape(new Vector3(0, 0, 0), new Vector3(0, 0, 1), 0.5, 2);
        const sdf = createSdf(shape);
        assert.equal(sdf(new Vector3(0, 0, -1)), 1, "bottom-1");
        assert.equal(sdf(new Vector3(0, 0, 0)), 0, "bottom");
        assert.equal(sdf(new Vector3(0, 0, 1)), -0.5, "center");
        assert.equal(sdf(new Vector3(0, 0, 2)), 0, "top");
        assert.equal(sdf(new Vector3(0, 0, 3)), 1, "top+1");
    });
});

QUnit.module('gpu-sdf', function () {
    QUnit.test('sdf cylinder match cpu impl', async function (assert) {
        const adapter = await navigator.gpu.requestAdapter();
        const device = await adapter.requestDevice();
        const kernels = new GpuKernels(device);

        const num = 10;

        const shape = createCylinderShape(new Vector3(0, 0, 0), new Vector3(0, 0, 1), 0.5, 2);

        const vg = new VoxelGridGpu(kernels, 0.4, num, num, num, new Vector3(-2, -2, -2), "f32");
        const readVg = kernels.createLikeCpu(vg);
        kernels.registerMapFn("sdf", "f32", "f32", uberSdfSnippet("p", "vo"), uberSdfUniformDefs);

        kernels.map("sdf", kernels.createLike(vg), vg, uberSdfUniformVars(shape));
        await kernels.copy(vg, readVg);
        const sdfRef = createSdf(shape);
        for (let iz = 0; iz < num; iz++) {
            for (let iy = 0; iy < num; iy++) {
                for (let ix = 0; ix < num; ix++) {
                    const pos = readVg.centerOf(ix, iy, iz);
                    assert.closeTo(readVg.get(ix, iy, iz), sdfRef(pos), 1e-6);
                }
            }
        }
    });

    QUnit.test('sdf ELH match cpu impl', async function (assert) {
        const adapter = await navigator.gpu.requestAdapter();
        const device = await adapter.requestDevice();
        const kernels = new GpuKernels(device);

        const num = 10;

        const shape = createELHShape(new Vector3(0, 0, -1), new Vector3(0, 1, -1), new Vector3(0, 0, 1), 1, 0.1);

        const vg = new VoxelGridGpu(kernels, 0.4, num, num, num, new Vector3(-2, -2, -2), "f32");
        const readVg = kernels.createLikeCpu(vg);
        kernels.registerMapFn("sdf", "f32", "f32", uberSdfSnippet("p", "vo"), uberSdfUniformDefs);

        kernels.map("sdf", kernels.createLike(vg), vg, uberSdfUniformVars(shape));
        await kernels.copy(vg, readVg);
        const sdfRef = createSdf(shape);
        for (let iz = 0; iz < num; iz++) {
            for (let iy = 0; iy < num; iy++) {
                for (let ix = 0; ix < num; ix++) {
                    const pos = readVg.centerOf(ix, iy, iz);
                    assert.closeTo(readVg.get(ix, iy, iz), sdfRef(pos), 1e-6);
                }
            }
        }
    });

    QUnit.test('sdf box match cpu impl', async function (assert) {
        const adapter = await navigator.gpu.requestAdapter();
        const device = await adapter.requestDevice();
        const kernels = new GpuKernels(device);

        const num = 10;

        const shape = createBoxShape(new Vector3(0, 0, 0.5), new Vector3(3, 0, 0), new Vector3(0, 2, 0), new Vector3(0, 0, -1));

        const vg = new VoxelGridGpu(kernels, 0.4, num, num, num, new Vector3(-2, -2, -2), "f32");
        const readVg = kernels.createLikeCpu(vg);
        kernels.registerMapFn("sdf", "f32", "f32", uberSdfSnippet("p", "vo"), uberSdfUniformDefs);

        kernels.map("sdf", kernels.createLike(vg), vg, uberSdfUniformVars(shape));
        await kernels.copy(vg, readVg);
        const sdfRef = createSdf(shape);
        for (let iz = 0; iz < num; iz++) {
            for (let iy = 0; iy < num; iy++) {
                for (let ix = 0; ix < num; ix++) {
                    const pos = readVg.centerOf(ix, iy, iz);
                    assert.closeTo(readVg.get(ix, iy, iz), sdfRef(pos), 1e-6);
                }
            }
        }
    });
});

QUnit.module('gpu', function () {
    QUnit.test('gpu->cpu', async function (assert) {
        const adapter = await navigator.gpu.requestAdapter();
        const device = await adapter.requestDevice();
        const kernels = new GpuKernels(device);

        const gpu = new VoxelGridGpu(kernels, 0.1, 1, 1, 1, new Vector3(0, 0, 0), "u32");
        const cpu = new VoxelGridCpu(0.1, 1, 1, 1, new Vector3(0, 0, 0), "u32");
        cpu.fill(0);

        device.queue.writeBuffer(gpu.buffer, 0, new Uint32Array([123]));
        await device.queue.onSubmittedWorkDone();
        await kernels.copy(gpu, cpu);

        assert.equal(cpu.get(0, 0, 0), 123);
    });

    QUnit.test('reduce-sum', async function (assert) {
        const adapter = await navigator.gpu.requestAdapter();
        const device = await adapter.requestDevice();
        const kernels = new GpuKernels(device);

        const testCases = [
            [1, 1, 1], // minimum
            [11, 13, 17], // small-ish primes
            [1, 1, 127], // WG boundary-
            [1, 1, 128], // WG boundary
            [1, 1, 129], // WG boundary+
            [1, 1, 261392], // real-world failing case
        ];

        for (const [nx, ny, nz] of testCases) {
            const vg = new VoxelGridGpu(kernels, 1, nx, ny, nz, new Vector3(), "u32");
            kernels.fill1(vg);
            const sum = await kernels.reduce("sum", vg);
            assert.equal(sum, nx * ny * nz);
        }
    });

    QUnit.test('countInShape-match-cpu', async function (assert) {
        const adapter = await navigator.gpu.requestAdapter();
        const device = await adapter.requestDevice();
        const kernels = new GpuKernels(device);

        // Prepare arbitrary filled grids.
        const gridCpu = new VoxelGridCpu(0.1, 10, 10, 10, new Vector3(0, 0, 0), "u32");
        gridCpu.map((v, p) => p.z > 0.5);
        const gridGpu = kernels.createLike(gridCpu);
        await kernels.copy(gridCpu, gridGpu);

        // Arbitrary shape.
        const shape = createBoxShape(new Vector3(0.5, 0.5, 0.5), new Vector3(0.2, 0, 0), new Vector3(0, 0.2, 0), new Vector3(0, 0, 0.2));

        const sdf = createSdf(shape);
        const ref = gridCpu.countIf((v, p) => v > 0 && sdf(p) <= 0);
        const test = await kernels.countInShape(shape, gridGpu, "nearest");
        assert.equal(test, ref);
    });
});
