import { Vector3 } from 'three';
import { createSdfBox, createSdfCylinder, createSdfElh, GpuKernels, VoxelGridCpu, VoxelGridGpu, wgslSdfCylinderSnippet, wgslSdfElhSnippet, wgslSdfBoxSnippet } from '../voxel.js';

QUnit.module('cpu-sdf', function () {
    QUnit.test('sdf cube', function (assert) {
        // create box [0,1]^3.
        const sdf = createSdfBox(new Vector3(0.5, 0.5, 0.5), new Vector3(0.5, 0, 0), new Vector3(0, 0.5, 0), new Vector3(0, 0, 0.5));

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
        const sdf = createSdfBox(new Vector3(0, 0, 0), new Vector3(0.5, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1.5));
        assert.equal(sdf(new Vector3(0, 0, 0)), -0.5, "center");
        assert.equal(sdf(new Vector3(-0.5, 0, 0)), 0, "X-");
        assert.equal(sdf(new Vector3(0, -1, 0)), 0, "Y-");
        assert.equal(sdf(new Vector3(0, 0, -1.5)), 0, "Z-");
    });

    QUnit.test('sdf cylinder', function (assert) {
        const sdf = createSdfCylinder(new Vector3(0, 0, 0), new Vector3(0, 0, 1), 0.5, 2);
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

        const vg = new VoxelGridGpu(kernels, 0.4, num, num, num, new Vector3(-2, -2, -2), "f32");
        const readVg = kernels.createLikeCpu(vg);
        kernels.registerMapFn("sdf", "f32", "f32", wgslSdfCylinderSnippet("p", "vo"), { _sd_p: "vec3f", _sd_n: "vec3f", _sd_r: "f32", _sd_h: "f32" });

        const p = new Vector3(0, 0, -1);
        const n = new Vector3(0, 0, 1);
        const r = 1;
        const h = 0.1;
        await kernels.map("sdf", vg /* not used */, vg, { _sd_p: p, _sd_n: n, _sd_r: r, _sd_h: h });
        await kernels.copy(vg, readVg);
        const sdfRef = createSdfCylinder(p, n, r, h);
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

        const vg = new VoxelGridGpu(kernels, 0.4, num, num, num, new Vector3(-2, -2, -2), "f32");
        const readVg = kernels.createLikeCpu(vg);
        kernels.registerMapFn("sdf", "f32", "f32", wgslSdfElhSnippet("p", "vo"), { _sd_p: "vec3f", _sd_q: "vec3f", _sd_n: "vec3f", _sd_r: "f32", _sd_h: "f32" });

        const p = new Vector3(0, 0, -1);
        const q = new Vector3(0, 1, -1);
        const n = new Vector3(0, 0, 1);
        const r = 1;
        const h = 0.1;
        await kernels.map("sdf", vg /* not used */, vg, { _sd_p: p, _sd_q: q, _sd_n: n, _sd_r: r, _sd_h: h });
        await kernels.copy(vg, readVg);
        const sdfRef = createSdfElh(p, q, n, r, h);
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

        const vg = new VoxelGridGpu(kernels, 0.4, num, num, num, new Vector3(-2, -2, -2), "f32");
        const readVg = kernels.createLikeCpu(vg);
        kernels.registerMapFn("sdf", "f32", "f32", wgslSdfBoxSnippet("p", "vo"), { _sd_c: "vec3f", _sd_hv0: "vec3f", _sd_hv1: "vec3f", _sd_hv2: "vec3f" });

        const c = new Vector3(0, 0, 0.5);
        const hv0 = new Vector3(3, 0, 0);
        const hv1 = new Vector3(0, 2, 0);
        const hv2 = new Vector3(0, 0, -1);
        await kernels.map("sdf", vg /* not used */, vg, { _sd_c: c, _sd_hv0: hv0, _sd_hv1: hv1, _sd_hv2: hv2 });
        await kernels.copy(vg, readVg);
        const sdfRef = createSdfBox(c, hv0, hv1, hv2);
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
});
