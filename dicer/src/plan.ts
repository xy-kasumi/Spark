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

export type VisUpdater = (group: string, vs: Array<THREE.Object3D>, visible: boolean) => void;

/**
 * High-level mesh projection with visualization and error handling
 */
export const genPathByProjection = async (
    targetManifold: ManifoldHandle, stockManifold: ManifoldHandle,
    wasmGeom: WasmGeom, updateVis: VisUpdater): Promise<{ path: PathSegment[], stockAfterCut: ManifoldHandle }> => {
    const viewVector = new THREE.Vector3(0, 1, 0);

    // Generate orthonormal basis from view vector
    const viewZ = viewVector.clone().normalize();
    const temp = Math.abs(viewZ.dot(new THREE.Vector3(1, 0, 0))) > 0.9 ?
        new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const viewX = temp.clone().sub(viewZ.clone().multiplyScalar(temp.dot(viewZ))).normalize();
    const viewY = viewZ.clone().cross(viewX);
    const origin = new THREE.Vector3(0, 0, 0);

    console.log(`View basis: X(${viewX.x.toFixed(3)}, ${viewX.y.toFixed(3)}, ${viewX.z.toFixed(3)}) ` +
        `Y(${viewY.x.toFixed(3)}, ${viewY.y.toFixed(3)}, ${viewY.z.toFixed(3)}) ` +
        `Z(${viewZ.x.toFixed(3)}, ${viewZ.y.toFixed(3)}, ${viewZ.z.toFixed(3)})`);

    const toolRadius = 1.5; // 0.15; // 1.5;
    const startTime = performance.now();
    let offsets = [toolRadius]; // [toolRadius * 3, toolRadius * 2, toolRadius * 1];
    let contours = [];
    let contour0 = wasmGeom.projectManifold(targetManifold, origin, viewX, viewY, viewZ);
    // contour0 = wasmGeom.outermostCrossSection(contour0);
    for (const offset of offsets) {
        const toolCenterContour = wasmGeom.offsetCrossSection(contour0, offset);
        contours = [...contours, wasmGeom.crossSectionToContours(toolCenterContour)];

        const innerContour = wasmGeom.offsetCrossSectionCircle(toolCenterContour, -toolRadius, 32);
        const cutCS = wasmGeom.createSquareCrossSection(100); // big enough to contain both work and target.
        const removeCS = wasmGeom.subtractCrossSection(cutCS, innerContour);
        const removeMani = wasmGeom.extrude(removeCS, viewX, viewY, viewZ, viewZ.clone().multiplyScalar(-50), 100); // 100mm should be big enough
        const actualRemovedMani = wasmGeom.intersectMesh(stockManifold, removeMani);
        console.log("removed volume", wasmGeom.volumeManifold(actualRemovedMani));
        stockManifold = wasmGeom.subtractMesh(stockManifold, removeMani); // update
    }
    const endTime = performance.now();
    console.log(`cut took ${(endTime - startTime).toFixed(2)}ms`);


    // visualize stock manifold
    {
        const material = new THREE.MeshPhysicalMaterial({
            color: "green",
            metalness: 0.1,
            roughness: 0.8,
            //transparent: true,
            //wireframe: true,
            //opacity: 0.9,
        });
        const mesh = new THREE.Mesh(wasmGeom.manifoldToGeometry(stockManifold), material);
        updateVis("work", [mesh], true);
    }

    // Visualize contours on the view plane using LineLoop
    const contourObjects: THREE.Object3D[] = [];
    const material = new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2 });
    const material2 = new THREE.LineBasicMaterial({ color: 0x0000ff, linewidth: 2 });
    let pathBase = [];
    for (const contour of contours) {
        for (const poly of contour) {
            let cutCurves = cutPolygon(poly, new THREE.Vector2(0, 1), 0);
            console.log(cutCurves);

            if (cutCurves.length === 0) {
                // not intersecting (bug)
                const points3D: THREE.Vector3[] = [];
                for (const point2D of poly) {
                    const point3D = origin.clone()
                        .add(viewX.clone().multiplyScalar(point2D.x))
                        .add(viewY.clone().multiplyScalar(point2D.y));
                    points3D.push(point3D);
                }
                const geometry = new THREE.BufferGeometry().setFromPoints(points3D);
                const lineLoop = new THREE.LineLoop(geometry, material);
                contourObjects.push(lineLoop);
            } else {
                cutCurves = [cutCurves[1]]; // TODO: fix
                let pos = true;
                for (const cutCurve of cutCurves) {
                    const points3D: THREE.Vector3[] = [];
                    const points3DWork: THREE.Vector3[] = [];
                    for (const point2D of cutCurve) {
                        const point3D = origin.clone()
                            .add(viewX.clone().multiplyScalar(point2D.x))
                            .add(viewY.clone().multiplyScalar(point2D.y));
                        points3D.push(point3D);

                        const points3DW = new THREE.Vector3(-19, 0, 0)
                            .add(new THREE.Vector3(0, 1, 0).multiplyScalar(point2D.x))
                            .add(new THREE.Vector3(1, 0, 0).multiplyScalar(point2D.y));
                        points3DWork.push(points3DW);
                    }
                    const geometry = new THREE.BufferGeometry().setFromPoints(points3D);
                    const line = new THREE.Line(geometry, pos ? material : material2);
                    contourObjects.push(line);
                    pos = !pos;
                    pathBase = points3DWork;
                }
            }
        }
    }
    updateVis("misc", contourObjects, true);

    // saw pattern
    pathBase = convertToSawPath(pathBase, 0.1);

    const evacLength = 2;
    const insP = pathBase[0].clone().add(new THREE.Vector3(0, -evacLength, 0))
    pathBase.splice(0, 0, insP);

    const insQ = pathBase[pathBase.length - 1].clone().add(new THREE.Vector3(0, evacLength, 0))
    pathBase.push(insQ);

    const geom = new THREE.BufferGeometry().setFromPoints(pathBase);
    const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 2 }));
    updateVis("path-base", [line], true);

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
