import { Vector2, Vector3 } from 'three';

// Voxelize a surface. Sets 255 for fully occupied, 128 for partially occupied, 0 for empty.
//
// [in] surf, array of float, triangle soup. [x0, y0, z0, x1, y1, z1, ...]
// [in] vg, VoxelGrid-like object. Needs to implement ofs, res, numX, numY, numZ, set, count, volume.
//
// TODO: this logic still missses tiny features like a screw lead. Need to sample many and reduce later.
// 0.5mm grid is obviously not enough to capture M1 screw lead mountains.
export const diceSurf = (surf, vg) => {
    for (let iz = 0; iz < vg.numZ; iz++) {
        const sliceZ0 = vg.ofs.z + iz * vg.res;
        const sliceZ1 = vg.ofs.z + (iz + 1) * vg.res;

        //const cont = sliceSurfByPlane(surf, sliceZ);
        const contZ0 = sliceSurfByPlane(surf, sliceZ0);
        const contZ1 = sliceSurfByPlane(surf, sliceZ1);

        for (let iy = 0; iy < vg.numY; iy++) {
            const sliceY0 = vg.ofs.y + iy * vg.res;
            const sliceY1 = vg.ofs.y + (iy + 1) * vg.res;

            //const bnds = sliceContourByLine(cont, sliceY);
            const bnds00 = sliceContourByLine(contZ0, sliceY0);
            const bnds01 = sliceContourByLine(contZ1, sliceY0);
            const bnds10 = sliceContourByLine(contZ0, sliceY1);
            //console.log(`Z1=${sliceZ1}, Y1=${sliceY1}`);
            const bnds11 = sliceContourByLine(contZ1, sliceY1);

            for (let ix = 0; ix < vg.numX; ix++) {
                const sliceX0 = vg.ofs.x + ix * vg.res;
                const sliceX1 = vg.ofs.x + (ix + 1) * vg.res;

                let numInside = 0;
                numInside += isValueInside(sliceX0, bnds00) ? 1 : 0;
                numInside += isValueInside(sliceX0, bnds01) ? 1 : 0;
                numInside += isValueInside(sliceX0, bnds10) ? 1 : 0;
                numInside += isValueInside(sliceX0, bnds11) ? 1 : 0;
                numInside += isValueInside(sliceX1, bnds00) ? 1 : 0;
                numInside += isValueInside(sliceX1, bnds01) ? 1 : 0;
                numInside += isValueInside(sliceX1, bnds10) ? 1 : 0;
                numInside += isValueInside(sliceX1, bnds11) ? 1 : 0;

                //const isInside = isValueInside(sliceX, bnds);
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
    return vg;
};


// surfTris: [x0, y0, z0, x1, y1, z1, ...]
// returns: contour edges
const sliceSurfByPlane = (surfTris, sliceZ) => {
    const segs = [];

    // tris are CCW.
    const numTris = surfTris.length / 9;
    for (let i = 0; i < numTris; i++) {
        const p0 = new Vector3(surfTris[9 * i + 0], surfTris[9 * i + 1], surfTris[9 * i + 2]);
        const p1 = new Vector3(surfTris[9 * i + 3], surfTris[9 * i + 4], surfTris[9 * i + 5]);
        const p2 = new Vector3(surfTris[9 * i + 6], surfTris[9 * i + 7], surfTris[9 * i + 8]);

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

        // intersect 3 edges with
        let up = null;
        let down = null;
        if (s0 < 0 && s1 >= 0) {
            up = isectLine(p0, p1, sliceZ);
        } else if (s0 >= 0 && s1 < 0) {
            down = isectLine(p0, p1, sliceZ);
        }

        if (s1 < 0 && s2 >= 0) {
            up = isectLine(p1, p2, sliceZ);
        } else if (s1 >= 0 && s2 < 0) {
            down = isectLine(p1, p2, sliceZ);
        }

        if (s2 < 0 && s0 >= 0) {
            up = isectLine(p2, p0, sliceZ);
        } else if (s2 >= 0 && s0 < 0) {
            down = isectLine(p2, p0, sliceZ);
        }

        if (up === null || down === null) {
            throw "Degenerate triangle";
        }

        segs.push(down.x, down.y, up.x, up.y); // down -> up is CCW contor in XY plane.
    }

    return segs;
};


// contEdges: [x0, y0, x1, y1, ...]
// returns: seg set [x0, x1, x2, ...]
const sliceContourByLine = (contEdges, sliceY) => {
    const bnds = [];
    const numEdges = contEdges.length / 4;
    for (let i = 0; i < numEdges; i++) {
        const p0 = new Vector2(contEdges[4 * i + 0], contEdges[4 * i + 1]);
        const p1 = new Vector2(contEdges[4 * i + 2], contEdges[4 * i + 3]);

        const s0 = Math.sign(p0.y - sliceY);
        const s1 = Math.sign(p1.y - sliceY);

        // early exit
        if (s0 >= 0 && s1 >= 0) {
            continue;
        }
        if (s0 < 0 && s1 < 0) {
            continue;
        }

        const isect = isectLine2(p0, p1, sliceY);
        bnds.push({ x: isect.x, isEnter: s0 >= 0 });
    }
    bnds.sort((a, b) => a.x - b.x);

    const bndsClean = [];
    let insideness = 0; // supports non-manifold, nested surfaces by allowing multiple enter.
    bnds.forEach(b => {
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
    });
    if (insideness !== 0) {
        console.error("Corrupt surface data (hole)");
    }
    if (bndsClean.length % 2 !== 0) {
        bndsClean.pop();
    }

    return bndsClean;
};

// [in] q: query point
// [in] xs: segment set [x0, x1], [x2, x3], ... (x0 < x1 < x2 < x3 < ...) even number of elements.
// [out] true if q is inside
const isValueInside = (q, xs) => {
    if (xs.length % 2 !== 0) {
        throw "Corrupt segment set"; // TODO: may need to handle gracefully.
    }

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

const isectLine = (p, q, z) => {
    const d = q.z - p.z;
    const t = (d === 0) ? 0.5 : (z - p.z) / d;
    return p.clone().lerp(q, t);
};


const isectLine2 = (p, q, y) => {
    const d = q.y - p.y;
    const t = (d === 0) ? 0.5 : (y - p.y) / d;
    return p.clone().lerp(q, t);
};
