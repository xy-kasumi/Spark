import { Vector3 } from 'three';
import { createSdfBox, createSdfCylinder, GpuKernels, VoxelGridCpu, VoxelGridGpu } from '../voxel.js';

QUnit.module('sdf', function() {
    QUnit.test('sdf cube', function(assert) {
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

    QUnit.test('sdf box', function(assert) {
        const sdf = createSdfBox(new Vector3(0, 0, 0), new Vector3(0.5, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1.5));
        assert.equal(sdf(new Vector3(0, 0, 0)), -0.5, "center");
        assert.equal(sdf(new Vector3(-0.5, 0, 0)), 0, "X-");
        assert.equal(sdf(new Vector3(0, -1, 0)), 0, "Y-");
        assert.equal(sdf(new Vector3(0, 0, -1.5)), 0, "Z-");
    });

    QUnit.test('sdf cylinder', function(assert) {
        const sdf = createSdfCylinder(new Vector3(0, 0, 0), new Vector3(0, 0, 1), 0.5, 2);
        assert.equal(sdf(new Vector3(0, 0, -1)), 1, "bottom-1");
        assert.equal(sdf(new Vector3(0, 0, 0)), 0, "bottom");
        assert.equal(sdf(new Vector3(0, 0, 1)), -0.5, "center");
        assert.equal(sdf(new Vector3(0, 0, 2)), 0, "top");
        assert.equal(sdf(new Vector3(0, 0, 3)), 1, "top+1");
    });
});

QUnit.module('gpu', function() {
    QUnit.test('gpu->cpu', async function(assert) {
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
