// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * CPU misc geometry operations.
 */
import { Vector3, Vector2, BufferGeometry } from 'three';

/**
 * Return the intersection point of the line segment (p, q) and line (normal, ofs), by assuming they're intersecting.
 */
const isectLineAlways = (p: Vector2, q: Vector2, normal: Vector2, ofs: number): Vector2 => {
    const tp = normal.dot(p);
    const tq = normal.dot(q);
    const dt = tq - tp;
    if (Math.abs(dt) < 1e-6) {
        // can't determine (parallel). return mid-point.
        return p.clone().add(q).multiplyScalar(0.5);
    }
    let k = (ofs - tp) / (tq - tp);
    k = Math.max(0, Math.min(1, k));
    return p.clone().lerp(q, k);
};

/**
 * Cut a closed polygon (CCW) by the line into curves.
 * Returned curve is ordered in [positive-side, negative-side, positive-side, ...] order.
 * In [curve0, curve1, ...], curve0.last = curve1.first, so on.
 * Returned array length will be always even, and each element will contain at least 2 points.
 * Returns empty array if the polygon does not intersect with the line.
 * 
 * New points will be synthesized to represent intersection points.
 * 
 * line: {p | dot(p, normal) = ofs}
 * @param poly Closed polygon (CCW)
 * @param normal line normal (must be normalized)
 */
export const cutPolygon = (poly: Vector2[], normal: Vector2, ofs: number): Vector2[][] => {
    const len = poly.length;
    if (len < 2) {
        throw "Invalid polygon";
    }

    const prev = (ix) => (ix + len - 1) % len;

    const sides: boolean[] = [];
    for (const point of poly) {
        sides.push(normal.dot(point) - ofs >= 0);
    }

    // Early exit when poly is not intersecting.
    if (sides.every((_, ix) => sides[ix]) || sides.every((_, ix) => !sides[ix])) {
        return [];
    }

    // Find starting point of pos-side segment.
    const firstPosIx = sides.findIndex((v, ix) => !sides[prev(ix)] && v);
    console.assert(firstPosIx >= 0);

    const segments: Vector2[][] = [];
    let currSeg: Vector2[] = [];
    for (let dix = 0; dix < len; dix++) {
        const ix = (firstPosIx + dix) % len;

        if (sides[ix] !== sides[prev(ix)]) {
            // end previous segment (open)
            if (currSeg.length > 0) {
                segments.push(currSeg);
                currSeg = [];
            }
            // start new segment with cut point (closed).
            const cutPoint = isectLineAlways(poly[prev(ix)], poly[ix], normal, ofs);
            currSeg.push(cutPoint);
        }
        currSeg.push(poly[ix]);
    }
    // end last segment.
    if (currSeg.length > 0) {
        segments.push(currSeg);
    }
    console.assert(segments.length % 2 === 0);

    // Augment: (closed,open) -> (closed,closed)
    for (let segIx = 0; segIx < segments.length; segIx++) {
        const seg = segments[segIx];
        const nextSeg = segments[(segIx + 1) % segments.length];
        console.assert(nextSeg.length >= 1);
        seg.push(nextSeg[0]);
    }
    return segments;
};

/**
 * Compute AABB from points array
 * @param geom Geometry
 * @returns AABB bounds
 */
export const computeAABB = (geom: BufferGeometry): { min: Vector3, max: Vector3 } => {
    const pts = geom.getAttribute("position").array;

    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < pts.length; i += 3) {
        const v = new Vector3(pts[i + 0], pts[i + 1], pts[i + 2]);
        min.min(v);
        max.max(v);
    }
    return { min, max };
};


/**
 * Apply translation to geometry in-place
 * @param geom Geometry to translate
 * @param trans Translation vector
 */
export const translateGeom = (geom: BufferGeometry, trans: Vector3) => {
    const pos = geom.getAttribute("position").array;
    for (let i = 0; i < pos.length; i += 3) {
        pos[i + 0] += trans.x;
        pos[i + 1] += trans.y;
        pos[i + 2] += trans.z;
    }
};
