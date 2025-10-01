// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from 'three';

import { WasmGeom, ManifoldHandle } from './wasm-geom.js';
import { cutPolygon } from './cpu-geom.js';
import { SegmentType, PathSegment } from './gcode';


/**
 * Generate stock cylinder geometry, spanning Z [0, stockHeight]
 * @param stockRadius Radius of the stock
 * @param stockHeight Height of the stock
 * @returns Stock cylinder geometry
 */
export const generateStockGeom = (stockRadius: number = 7.5, stockHeight: number = 15): THREE.BufferGeometry => {
    const geom = new THREE.CylinderGeometry(stockRadius, stockRadius, stockHeight, 64, 1);
    const transf = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 0, stockHeight / 2),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
        new THREE.Vector3(1, 1, 1));
    geom.applyMatrix4(transf);
    return geom;
};

export type VisUpdater = (vs: Array<THREE.Object3D>) => void;

/**
 * Generates contour cut path (after target after the cut).
 * 
 * @param targetManifold target shape (setup coords). All points must fit in Z>=0 half space.
 * @param stockManifold stock shape (setup coords).
 * @param updateVis function to update visualization in UI
 */
export const genPathByProjection = async (
    targetManifold: ManifoldHandle, stockManifold: ManifoldHandle,
    wasmGeom: WasmGeom, updateVis: VisUpdater): Promise<{ path: PathSegment[], stockAfterCut: ManifoldHandle }> => {

    const viewX = new THREE.Vector3(1, 0, 0);
    const viewY = new THREE.Vector3(0, 0, -1);
    const viewZ = new THREE.Vector3(0, 1, 0);
    const origin = new THREE.Vector3(0, 0, 0);

    // Convert point on the projection plane in setup coords.
    const pt2DToSetup = (pt: THREE.Vector2): THREE.Vector3 =>
        origin.clone()
            .add(viewX.clone().multiplyScalar(pt.x))
            .add(viewY.clone().multiplyScalar(pt.y));

    console.log(`projection basis: ` +
        `X(${viewX.x.toFixed(3)}, ${viewX.y.toFixed(3)}, ${viewX.z.toFixed(3)}) ` +
        `Y(${viewY.x.toFixed(3)}, ${viewY.y.toFixed(3)}, ${viewY.z.toFixed(3)}) ` +
        `Z(${viewZ.x.toFixed(3)}, ${viewZ.y.toFixed(3)}, ${viewZ.z.toFixed(3)})`);

    const toolRadius = 1.5;
    const startTime = performance.now();
    const offset = toolRadius;

    // compute contour
    const toolCenterCS = wasmGeom.offsetCrossSection(wasmGeom.projectManifold(targetManifold, origin, viewX, viewY, viewZ), offset);
    const contour = wasmGeom.crossSectionToContours(toolCenterCS);

    // compute cut
    // NOTE: this is messy, and inaccurate (removes Z<0 region errorneously). 
    {
        const innerContour = wasmGeom.offsetCrossSectionCircle(toolCenterCS, -toolRadius, 32);
        const cutCS = wasmGeom.createSquareCrossSection(100); // big enough to contain both work and target.
        const removeCS = wasmGeom.subtractCrossSection(cutCS, innerContour);
        const removeMani = wasmGeom.extrude(removeCS, viewX, viewY, viewZ, viewZ.clone().multiplyScalar(-50), 100); // 100mm should be big enough
        const actualRemovedMani = wasmGeom.intersectMesh(stockManifold, removeMani);
        console.log("removed volume", wasmGeom.volumeManifold(actualRemovedMani));
        stockManifold = wasmGeom.subtractMesh(stockManifold, removeMani); // update
    }

    const endTime = performance.now();
    console.log(`cut took ${(endTime - startTime).toFixed(2)}ms`);

    // Visualize contours on the view plane using LineLoop
    let pathBase = [];

    if (contour.length > 1) {
        throw new Error("A contour with multiple polygons (implies holes) is not supported yet");
    }
    // Only retain Z+ region. Since viewY = (0,0,-1), we cut by Y=0 line, and keep (Y-)negative region to get it.
    const poly = contour[0];
    const cutCurves = cutPolygon(poly, new THREE.Vector2(0, 1), 0);
    if (cutCurves.length !== 2) {
        throw new Error(`When processing a contour (cut at Z=0), ${cutCurves.length} curves was generated (expecting 2). a bug.`)
    }
    const cutCurve = cutCurves[1]; // get neg of [pos, neg]

    const points3D: THREE.Vector3[] = [];
    const points3DWork: THREE.Vector3[] = [];
    for (const point2D of cutCurve) {
        points3D.push(pt2DToSetup(point2D));

        const points3DW = new THREE.Vector3(-19, 0, 0)
            .add(new THREE.Vector3(0, 1, 0).multiplyScalar(point2D.x))
            .add(new THREE.Vector3(1, 0, 0).multiplyScalar(point2D.y));
        points3DWork.push(points3DW);
    }
    pathBase = points3DWork;

    const geometry = new THREE.BufferGeometry().setFromPoints(points3D);
    const contourObjects: THREE.Object3D[] = [new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2 }))];
    updateVis(contourObjects);

    const evacLength = 2;
    const insP = pathBase[0].clone().add(new THREE.Vector3(0, -evacLength, 0))
    pathBase.splice(0, 0, insP);

    const insQ = pathBase[pathBase.length - 1].clone().add(new THREE.Vector3(0, evacLength, 0))
    pathBase.push(insQ);

    const safeZ = 60;
    const opZ = 35;

    const wrap = (type: SegmentType, x: number, y: number, z: number): PathSegment => {
        return {
            type: type,
            axisValues: {
                x: x,
                y: y,
                z: z,
            },
        };
    };

    let planPath = [];
    planPath.push(wrap("move", insP.x, insP.y, safeZ));
    planPath.push(wrap("move", insP.x, insP.y, opZ));
    planPath = planPath.concat(pathBase.map(pt => wrap("remove-work", pt.x, pt.y, opZ)));
    planPath.push(wrap("move", insQ.x, insQ.y, safeZ));
    return { path: planPath, stockAfterCut: stockManifold };
};


// Convert a curve into multiple segments whose length is pitch (or less).
// Each segment begin repeats previous segment's end.
const splitIntoSegments = (path: THREE.Vector2[], pitch: number): THREE.Vector2[][] => {
    const segs: THREE.Vector2[][] = [];
    let currSeg = [];
    let currLen = 0;
    for (const p of path) {
        if (currSeg.length === 0) {
            currSeg.push(p);
            continue;
        }

        while (true) {
            const currPt = currSeg[currSeg.length - 1];
            const dlen = p.distanceTo(currPt);
            if (currLen + dlen > pitch) {
                // need to split
                const segEnd = currPt.clone().lerp(p, (pitch - currLen) / dlen);
                currSeg.push(segEnd);
                segs.push(currSeg);

                // start new segment
                currSeg = [segEnd];
                currLen = 0;
            } else {
                currSeg.push(p);
                currLen += dlen;
                break;
            }
        }
    }
    if (currSeg.length >= 2) {
        segs.push(currSeg);
    }
    return segs;
};

const convertToSawPath = (path: THREE.Vector2[], pitch: number): THREE.Vector2[] => {
    const res = [];
    const segs = splitIntoSegments(path, pitch);
    console.log("saw cv", segs);
    for (let i = 0; i < segs.length; i++) {
        const fSeg = segs[i];
        const bSeg = new Array(...segs[i]).reverse();
        res.push(...fSeg.slice(0, -1));
        res.push(...bSeg.slice(0, -1));
        res.push(...fSeg.slice(0, -1));
    }
    res.push(path[path.length - 1]);
    return res;
};
