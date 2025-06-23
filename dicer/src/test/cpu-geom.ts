// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Vector3 } from 'three';
import { createBoxShape, createCylinderShape, createELHShape, createSdf } from '../cpu-geom.js';

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
