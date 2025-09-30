// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Vector2 } from 'three';
import { cutPolygon } from '../cpu-geom.js';

QUnit.module('cpu-2d', function () {
    QUnit.test('cut', function (assert) {
        const shape = [
            new Vector2(1, 1),
            new Vector2(-1, 1),
            new Vector2(-1, -1),
            new Vector2(1, -1),
        ];

        assert.deepEqual(cutPolygon(shape, new Vector2(0, 1), 2), [], "all-negative");
        assert.deepEqual(cutPolygon(shape, new Vector2(0, 1), -2), [], "all-positive");

        const res = cutPolygon(shape, new Vector2(0, 1), 0);
        assert.equal(res.length, 2, "square divides into 2 curves");
        assert.equal(res[0].length, 4);
        assert.equal(res[1].length, 4);

        assert.equal(new Vector2(1, 0).distanceTo(res[0][0]), 0);
        assert.equal(new Vector2(1, 1).distanceTo(res[0][1]), 0);
        assert.equal(new Vector2(-1, 1).distanceTo(res[0][2]), 0);
        assert.equal(new Vector2(-1, 0).distanceTo(res[0][3]), 0);

        assert.equal(new Vector2(-1, 0).distanceTo(res[1][0]), 0);
        assert.equal(new Vector2(-1, -1).distanceTo(res[1][1]), 0);
        assert.equal(new Vector2(1, -1).distanceTo(res[1][2]), 0);
        assert.equal(new Vector2(1, 0).distanceTo(res[1][3]), 0);
    });
});
