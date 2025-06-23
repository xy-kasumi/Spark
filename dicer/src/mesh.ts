// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Triangle mesh rasterization into voxel grid.
 */
import { VoxelGridCpu } from './voxel.js';
import { Vector2, Vector3 } from 'three';

/**
 * Voxelize a surface. Sets 255 for fully occupied, 128 for partially occupied, 0 for empty.
 * To test partialness, check 8 vertices of each voxel instead of center.
 * 
 * @param surf Array of float, triangle soup. [x0, y0, z0, x1, y1, z1, ...]
 * @param vg [out] VoxelGrid-like object. Needs to implement ofs, res, numX, numY, numZ, set, count, volume
 */
export const diceSurf = (surf: Float32Array, vg: any) => {
    // Grid whose voxel centers matches vg's voxel verticies.
    const vertVg = new VoxelGridCpu(vg.res, vg.numX + 1, vg.numY + 1, vg.numZ + 1, vg.ofs.clone().add(new Vector3(1, 1, 1).multiplyScalar(-0.5 * vg.res)));
    for (let iz = 0; iz < vertVg.numZ; iz++) {
        const contour = sliceSurfByPlane(surf, vertVg.ofs.z + (iz + 0.5) * vertVg.res);
        for (let iy = 0; iy < vertVg.numY; iy++) {
            const bnds = sliceContourByLine(contour, vertVg.ofs.y + (iy + 0.5) * vertVg.res);
            for (let ix = 0; ix < vertVg.numX; ix++) {
                const isInside = isValueInside(vertVg.ofs.x + (ix + 0.5) * vertVg.res, bnds);
                vertVg.set(ix, iy, iz, isInside ? 1 : 0);
            }
        }
    }

    // Gather 8 vertices into voxel.
    for (let iz = 0; iz < vg.numZ; iz++) {
        for (let iy = 0; iy < vg.numY; iy++) {
            for (let ix = 0; ix < vg.numX; ix++) {
                let numInside = 0;
                numInside += vertVg.get(ix, iy, iz);
                numInside += vertVg.get(ix, iy, iz + 1);
                numInside += vertVg.get(ix, iy + 1, iz);
                numInside += vertVg.get(ix, iy + 1, iz + 1);
                numInside += vertVg.get(ix + 1, iy, iz);
                numInside += vertVg.get(ix + 1, iy, iz + 1);
                numInside += vertVg.get(ix + 1, iy + 1, iz);
                numInside += vertVg.get(ix + 1, iy + 1, iz + 1);

                let cellV = 0;
                if (numInside === 8) {
                    cellV = 255;
                } else if (numInside > 0) {
                    cellV = 128;
                }
                vg.set(ix, iy, iz, cellV);
            }
        }
    }
};

/**
 * @param surfTris Triangle soup [x0, y0, z0, x1, y1, z1, ...] (Must be CCW)
 * @param sliceZ Z coordinate of slice plane
 * @returns Contour edges (CCW)
 */
const sliceSurfByPlane = (surfTris: Float32Array, sliceZ: number): number[] => {
    const segs = [];

    const p0 = new Vector3();
    const p1 = new Vector3();
    const p2 = new Vector3();
    const upTemp = new Vector3();
    const downTemp = new Vector3();

    const numTris = surfTris.length / 9;
    for (let i = 0; i < numTris; i++) {
        p0.set(surfTris[9 * i + 0], surfTris[9 * i + 1], surfTris[9 * i + 2]);
        p1.set(surfTris[9 * i + 3], surfTris[9 * i + 4], surfTris[9 * i + 5]);
        p2.set(surfTris[9 * i + 6], surfTris[9 * i + 7], surfTris[9 * i + 8]);

        const s0 = Math.sign(p0.z - sliceZ);
        const s1 = Math.sign(p1.z - sliceZ);
        const s2 = Math.sign(p2.z - sliceZ);

        // early exit
        if (s0 >= 0 && s1 >= 0 && s2 >= 0) {
            continue;
        }
        if (s0 < 0 && s1 < 0 && s2 < 0) {
            continue;
        }

        // intersect 3 edges with the plane.
        let up = null;
        let down = null;
        if (s0 < 0 && s1 >= 0) {
            up = isectLine(p0, p1, sliceZ, upTemp);
        } else if (s0 >= 0 && s1 < 0) {
            down = isectLine(p0, p1, sliceZ, downTemp);
        }

        if (s1 < 0 && s2 >= 0) {
            up = isectLine(p1, p2, sliceZ, upTemp);
        } else if (s1 >= 0 && s2 < 0) {
            down = isectLine(p1, p2, sliceZ, downTemp);
        }

        if (s2 < 0 && s0 >= 0) {
            up = isectLine(p2, p0, sliceZ, upTemp);
        } else if (s2 >= 0 && s0 < 0) {
            down = isectLine(p2, p0, sliceZ, downTemp);
        }

        if (up === null || down === null) {
            throw "Degenerate triangle";
        }

        segs.push(down.x, down.y, up.x, up.y); // down -> up is CCW contor in XY plane.
    }

    return segs;
};

/**
 * Slice contours in 2D plane by a line, to give a set of segments.
 * 
 * @param contEdges [x0, y0, x1, y1, ...]
 * @param sliceY Y coordinate of slice line
 * @returns Segment set [x0, x1, x2, ...]
 */
const sliceContourByLine = (contEdges: number[], sliceY: number): number[] => {
    const temp0 = new Vector2();
    const temp1 = new Vector2();
    const temp2 = new Vector2();

    const bnds = [];
    const numEdges = contEdges.length / 4;
    for (let i = 0; i < numEdges; i++) {
        const p0 = temp0.set(contEdges[4 * i + 0], contEdges[4 * i + 1]);
        const p1 = temp1.set(contEdges[4 * i + 2], contEdges[4 * i + 3]);

        const s0 = Math.sign(p0.y - sliceY);
        const s1 = Math.sign(p1.y - sliceY);

        // early exit
        if (s0 >= 0 && s1 >= 0) {
            continue;
        }
        if (s0 < 0 && s1 < 0) {
            continue;
        }

        const isect = isectLine2(p0, p1, sliceY, temp2);
        bnds.push({ x: isect.x, isEnter: s0 >= 0 });
    }
    bnds.sort((a, b) => a.x - b.x);

    const bndsClean = [];
    let insideness = 0; // supports non-manifold, nested surfaces by allowing multiple enter.
    for (const b of bnds) {
        if (b.isEnter) {
            insideness++;
            if (insideness === 1) {
                bndsClean.push(b.x);
            }
        } else {
            insideness--;
            if (insideness === 0) {
                bndsClean.push(b.x);
            }
            if (insideness < 0) {
                // BUG: This cause false-positive, when a tangenting line intersects surface of a cylindrical mesh.
                // But looks like OK to ignore it for now. Need rigorous testing & numerical stability before prod.
                // temporarily disabled.
                //console.error("Corrupt surface data (hole)"); 
            }
        }
    }
    if (insideness !== 0) {
        console.error("Corrupt surface data (hole)");
    }
    if (bndsClean.length % 2 !== 0) {
        bndsClean.pop();
    }

    if (bndsClean.length % 2 !== 0) {
        throw "Corrupt segment set";
    }
    return bndsClean;
};

/**
 * Tests if a value is inside a segment set
 * @param q Query point
 * @param xs Segment set [x0, x1], [x2, x3], ... (x0 < x1 < x2 < x3 < ...) even number of elements
 * @returns True if q is inside
 */
const isValueInside = (q: number, xs: number[]): boolean => {
    for (let i = 0; i < xs.length; i += 2) {
        const x0 = xs[i];
        const x1 = xs[i + 1];
        if (q < x0) {
            return false;
        }
        if (q < x1) {
            return true;
        }
    }
    return false;
};

/**
 * Intersect 3D line segment with Z plane
 * @param p Start point
 * @param q End point
 * @param z Z coordinate of plane
 * @param buf [out] Buffer for intersection point
 * @returns Intersection point
 */
const isectLine = (p: Vector3, q: Vector3, z: number, buf = new Vector3()): Vector3 => {
    const d = q.z - p.z;
    const t = (d === 0) ? 0.5 : (z - p.z) / d;
    return buf.copy(p).lerp(q, t);
};

/**
 * Intersect 2D line segment with Y line
 * @param p Start point
 * @param q End point
 * @param y Y coordinate of line
 * @param buf [out] Buffer for intersection point
 * @returns Intersection point
 */
const isectLine2 = (p: Vector2, q: Vector2, y: number, buf = new Vector2()): Vector2 => {
    const d = q.y - p.y;
    const t = (d === 0) ? 0.5 : (y - p.y) / d;
    return buf.copy(p).lerp(q, t);
};
