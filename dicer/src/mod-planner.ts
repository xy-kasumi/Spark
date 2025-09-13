// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from 'three';
import { Vector3 } from 'three';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

import { debug, visDot, visQuad } from './debug.js';
import { ModuleFramework, Module } from './framework.js';
//import { diceSurf } from './mesh.js';
import { createELHShape, createCylinderShape, createBoxShape, VoxelGridGpu, GpuKernels, Shape } from './gpu-geom.js';
//import { VoxelGridCpu } from './cpu-geom.js';
//import { TrackingVoxelGrid, initVGForPoints } from './tracking-voxel.js';
import { WasmGeom, toTriSoup, ManifoldHandle } from './wasm-geom.js';
import { cutPolygon } from './cpu-geom.js';

/**
 * Apply translation to geometry in-place
 * @param geom Geometry to translate
 * @param trans Translation vector
 */
const translateGeom = (geom: THREE.BufferGeometry, trans: THREE.Vector3) => {
    const pos = geom.getAttribute("position").array;
    for (let i = 0; i < pos.length; i += 3) {
        pos[i + 0] += trans.x;
        pos[i + 1] += trans.y;
        pos[i + 2] += trans.z;
    }
};

/**
 * Get "triangle soup" representation from a geometry
 * @param geom Input geometry
 * @returns Triangle soup array
 */
const convGeomToSurf = (geom: THREE.BufferGeometry): Float32Array => {
    if (geom.index === null) {
        return geom.getAttribute("position").array;
    } else {
        const ix = geom.index.array;
        const pos = geom.getAttribute("position").array;

        const numTris = ix.length / 3;
        const buf = new Float32Array(numTris * 9);
        for (let i = 0; i < numTris; i++) {
            for (let v = 0; v < 3; v++) {
                const vIx = ix[3 * i + v];
                buf[9 * i + 3 * v + 0] = pos[3 * vIx + 0];
                buf[9 * i + 3 * v + 1] = pos[3 * vIx + 1];
                buf[9 * i + 3 * v + 2] = pos[3 * vIx + 2];
            }
        }
        return buf;
    }
};

/**
 * Generate stock cylinder geometry, spanning Z [0, stockHeight]
 * @param stockRadius Radius of the stock
 * @param stockHeight Height of the stock
 * @returns Stock cylinder geometry
 */
const generateStockGeom = (stockRadius: number = 7.5, stockHeight: number = 15): THREE.BufferGeometry => {
    const geom = new THREE.CylinderGeometry(stockRadius, stockRadius, stockHeight, 64, 1);
    const transf = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 0, stockHeight / 2),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
        new THREE.Vector3(1, 1, 1));
    geom.applyMatrix4(transf);
    return geom;
};


/**
 * Create occupancy voxel grid visualization.
 * @param vg Voxel grid to visualize (u32: 255:full, 128:partial, 0:empty)
 */
// const createOccupancyVis = (vg: VoxelGridCpu): THREE.Object3D => {
//     if (vg.type !== "u32") {
//         throw `Invalid vg type for occupancy: ${vg.type}`;
//     }

//     const t0 = performance.now();
//     const cubeSize = vg.res * 1.0;
//     const cubeGeom = new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize);

//     const meshContainer = new THREE.Object3D();
//     meshContainer.position.copy(vg.ofs);
//     const axesHelper = new THREE.AxesHelper();
//     axesHelper.scale.set(vg.res * vg.numX, vg.res * vg.numY, vg.res * vg.numZ);

//     const meshFull = new THREE.InstancedMesh(cubeGeom, new THREE.MeshLambertMaterial(), vg.countIf(val => val === 255));
//     const meshPartial = new THREE.InstancedMesh(cubeGeom, new THREE.MeshNormalMaterial({ transparent: true, opacity: 0.25 }), vg.countIf(val => val === 128));

//     let instanceIxFull = 0;
//     let instanceIxPartial = 0;
//     for (let iz = 0; iz < vg.numZ; iz++) {
//         for (let iy = 0; iy < vg.numY; iy++) {
//             for (let ix = 0; ix < vg.numX; ix++) {
//                 const v = vg.get(ix, iy, iz);
//                 if (v === 0) {
//                     continue;
//                 }

//                 // whatever different color gradient
//                 meshFull.setColorAt(instanceIxFull, new THREE.Color(ix * 0.01 + 0.5, iy * 0.01 + 0.5, iz * 0.01 + 0.5));

//                 const mtx = new THREE.Matrix4();
//                 mtx.compose(
//                     new THREE.Vector3(ix, iy, iz).addScalar(0.5).multiplyScalar(vg.res),
//                     new THREE.Quaternion(),
//                     new THREE.Vector3(1, 1, 1).multiplyScalar(v === 255 ? 1.0 : 0.8));

//                 if (v === 255) {
//                     meshFull.setMatrixAt(instanceIxFull, mtx);
//                     instanceIxFull++;
//                 } else {
//                     meshPartial.setMatrixAt(instanceIxPartial, mtx);
//                     instanceIxPartial++;
//                 }
//             }
//         }
//     }

//     meshContainer.add(meshFull);
//     meshContainer.add(meshPartial);
//     meshFull.add(axesHelper);

//     console.log(`  createOccupancyVis took ${performance.now() - t0}ms`);
//     return meshContainer;
// };

// const initCreateDeviationVis = (kernels) => {
//     // input: deviation (>=0: dev, -1: empty)
//     // output: mask (1: visible, 0: hidden)
//     // TODO: This uses lots of "hidden" impl detail of map. maybe better to move to voxel.js?
//     kernels.registerMapFn("visible_dev_mask", "f32", "u32", `
//         if (vi < 0) {
//             vo = 0;
//         } else if (any(index3 == vec3u(0)) || any(index3 + 1 == nums)) {
//             vo = 1; // boundary voxel is visible regardless of neighbors.
//         } else {
//             let ofs = array<vec3i, 6>(
//                 vec3i(1, 0, 0),
//                 vec3i(-1, 0, 0),
//                 vec3i(0, 1, 0),
//                 vec3i(0, -1, 0),
//                 vec3i(0, 0, 1),
//                 vec3i(0, 0, -1),
//             );
//             var has_empty_neighbor = false;
//             for (var i = 0u; i < 6u; i++) {
//                 let nix3 = vec3u(vec3i(index3) + ofs[i]);
//                 let nv = vs_in[compose_ix(nix3)];
//                 if (nv < 0) {
//                     has_empty_neighbor = true;
//                     break;
//                 }
//             }
//             // this voxel is visible through empty neighbor.
//             vo = select(0u, 1u, has_empty_neighbor);
//         }
//     `);

//     kernels.registerMapFn("cv_dev_data", "f32", "vec4f", `
//         vo = vec4f(p, vi);
//     `);

//     kernels.registerMapFn("max_dev_mask", "f32", "u32", `
//         vo = select(0u, 1u, vi >= max_dev);
//     `, { max_dev: "f32" });
// };

/**
 * Get max deviation from voxel grid.
 * @param kernels
 * @param vg f32 voxel grid
 * @returns Maximum deviation
 * @async
 */
// const getMaxDeviation = async (kernels: GpuKernels, vg: VoxelGridGpu) => {
//     return (await kernels.reduce("max", vg)) as number;
// };

/**
 * Create deviation voxel grid visualization. (blue: 0 deviation, red: maxDev deviation)
 * @param kernels
 * @param vg Voxel grid to visualize (f32: >=0: deviation, -1: empty)
 * @param maxDev Maximum deviation to visualize.
 * @async
 */
// const createDeviationVis = async (kernels: GpuKernels, vg: VoxelGridGpu, maxDev: number = 3): Promise<THREE.Object3D> => {
//     if (vg.type !== "f32") {
//         throw `Invalid vg type for deviation: ${vg.type}`;
//     }

//     const t0 = performance.now();

//     const cubeSize = vg.res * 1.0;
//     const cubeGeom = new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize);

//     const resultVis = new THREE.Object3D();
//     const axesHelper = new THREE.AxesHelper();
//     axesHelper.scale.set(vg.res * vg.numX, vg.res * vg.numY, vg.res * vg.numZ);
//     axesHelper.position.copy(vg.ofs);

//     // Extract visible voxels.
//     const maskVg = kernels.createLike(vg, "u32");
//     const dataVg = kernels.createLike(vg, "vec4f");
//     kernels.map("visible_dev_mask", vg, maskVg);
//     kernels.map("cv_dev_data", vg, dataVg);
//     const numVisible = (await kernels.reduce("sum", maskVg)) as number;
//     const packedResultBuf = kernels.createBuffer(16 * numVisible);
//     kernels.packRaw(maskVg, dataVg, packedResultBuf);
//     const packedResultBufCpu = new ArrayBuffer(16 * numVisible);
//     await kernels.copyBuffer(packedResultBuf, packedResultBufCpu);
//     packedResultBuf.destroy();
//     kernels.destroy(maskVg);
//     kernels.destroy(dataVg);

//     // Transform them into InstancedMesh.
//     const mesh = new THREE.InstancedMesh(cubeGeom, new THREE.MeshLambertMaterial(), numVisible);
//     const resultArr = new Float32Array(packedResultBufCpu); // px, py, pz, dev
//     const mtx = new THREE.Matrix4();
//     const col = new THREE.Color();
//     for (let i = 0; i < numVisible; i++) {
//         // set position
//         mtx.makeTranslation(resultArr[i * 4 + 0], resultArr[i * 4 + 1], resultArr[i * 4 + 2]);
//         mesh.setMatrixAt(i, mtx);

//         // set color, from blue(dev=0) to red(dev=maxDev).
//         const dev = resultArr[i * 4 + 3];
//         const t = Math.min(1, dev / maxDev);
//         mesh.setColorAt(i, col.setRGB(0.2 + t * 0.8, 0.2, 0.2 + (1 - t) * 0.8));
//     }

//     resultVis.add(mesh);
//     resultVis.add(axesHelper);

//     console.log(`  createDeviationVis took ${performance.now() - t0}ms`);
//     return resultVis;
// };

/**
 * Visualize "max deviation" in voxel grid.
 * @param kernels
 * @param vg Voxel grid to visualize (f32)
 * @param maxDev Maximum deviation to visualize
 * @async
 */
const createMaxDeviationVis = async (kernels: GpuKernels, vg: VoxelGridGpu, maxDev: number): Promise<THREE.Object3D> => {
    // Extract cells where dev == max_dev, and pack into array.
    const maskVg = kernels.createLike(vg, "u32");
    kernels.map("max_dev_mask", vg, maskVg, { max_dev: maxDev });

    const dataVg = kernels.createLike(vg, "vec4f");
    kernels.map("cv_dev_data", vg, dataVg);

    const numLocs = (await kernels.reduce("sum", maskVg)) as number;
    const locsBuf = kernels.createBuffer(16 * numLocs);
    kernels.packRaw(maskVg, dataVg, locsBuf);

    const locsBufCpu = new ArrayBuffer(16 * numLocs);
    await kernels.copyBuffer(locsBuf, locsBufCpu);
    kernels.destroy(maskVg);
    kernels.destroy(dataVg);
    locsBuf.destroy();

    // Convert to instanced mesh.
    const locsArr = new Float32Array(locsBufCpu);
    const mtx = new THREE.Matrix4();
    const vis = new THREE.InstancedMesh(new THREE.SphereGeometry(0.1), new THREE.MeshLambertMaterial({ color: "red" }), numLocs);
    for (let i = 0; i < numLocs; i++) {
        mtx.makeTranslation(locsArr[i * 4 + 0], locsArr[i * 4 + 1], locsArr[i * 4 + 2]);
        vis.setMatrixAt(i, mtx);
    }
    return vis;
};

interface PathSegment {
    type: string;
    tipPosM: THREE.Vector3;
    tipPosW: THREE.Vector3;
    axisValues: {
        x: number;
        y: number;
        z: number;
        b: number;
        c: number;
    };
    sweep: number;
    group: string;
    tipNormalW: THREE.Vector3;
    toolRotDelta?: number;
    grindDelta?: number;
}

interface Sweep {
    partialPath: PartialPath;
    ignoreOvercutErrors: boolean;
}

/**
 * Visualize tool tip path in machine coordinates.
 *
 * @param path Array of path segments
 * @param highlightSweep If specified, highlight this sweep.
 * @returns Path visualization object
 */
const createPathVis = (path: Array<PathSegment>, highlightSweep: number = -1): THREE.Object3D => {
    if (path.length === 0) {
        return new THREE.Object3D();
    }

    const pathVis = new THREE.Object3D();

    // add remove path vis
    const vs = [];
    const cs = [];
    let prevTipPosW = path[0].tipPosW;
    for (let i = 1; i < path.length; i++) {
        const pt = path[i];
        vs.push(prevTipPosW.x, prevTipPosW.y, prevTipPosW.z);
        vs.push(pt.tipPosW.x, pt.tipPosW.y, pt.tipPosW.z);

        if (pt.sweep === highlightSweep) {
            if (pt.type === "remove-work") {
                // red
                cs.push(0.8, 0, 0);
                cs.push(0.8, 0, 0);
            } else {
                // blue-ish gray
                cs.push(0.5, 0.5, 1);
                cs.push(0.5, 0.5, 1);
            }
        } else {
            if (pt.type === "remove-work") {
                // red-ish faint gray
                cs.push(1, 0.8, 0.8);
                cs.push(1, 0.8, 0.8);
            } else {
                // blue-ish faint gray
                cs.push(0.8, 0.8, 1);
                cs.push(0.8, 0.8, 1);
            }
        }
        prevTipPosW = pt.tipPosW;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vs), 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cs), 3));
    const mat = new THREE.LineBasicMaterial({ vertexColors: true });
    pathVis.add(new THREE.LineSegments(geom, mat));

    // add refresh path vis
    const sphGeom = new THREE.SphereGeometry(0.15);
    const sphRemoveMat = new THREE.MeshBasicMaterial({ color: "red" });
    const sphOtherMat = new THREE.MeshBasicMaterial({ color: "blue" });
    const sphNonHighlight = new THREE.MeshBasicMaterial({ color: "gray" });
    for (let i = 0; i < path.length; i++) {
        const pt = path[i];

        if (pt.sweep !== highlightSweep) {
            if (pt.type !== "remove-work") {
                const sph = new THREE.Mesh(sphGeom, sphNonHighlight);
                sph.position.copy(pt.tipPosW);
                pathVis.add(sph);
            }
        } else {
            if (pt.type === "remove-work") {
                const sph = new THREE.Mesh(sphGeom, sphRemoveMat);
                sph.position.copy(pt.tipPosW);
                pathVis.add(sph);
            } else {
                const sph = new THREE.Mesh(sphGeom, sphOtherMat);
                sph.position.copy(pt.tipPosW);
                pathVis.add(sph);
            }
        }
    }

    return pathVis;
};

/**
 * Generates a rotation matrix such that Z+ axis will be formed into "z" vector.
 * @param z Z-basis vector
 * @returns Rotation matrix
 */
const createRotationWithZ = (z: THREE.Vector3): THREE.Matrix4 => {
    // orthogonalize, with given Z-basis.
    const basisZ = z;
    let basisY;
    const b0 = new THREE.Vector3(1, 0, 0);
    const b1 = new THREE.Vector3(0, 1, 0);
    if (b0.clone().cross(basisZ).length() > 0.3) {
        basisY = b0.clone().cross(basisZ).normalize();
    } else {
        basisY = b1.clone().cross(basisZ).normalize();
    }
    const basisX = basisY.clone().cross(basisZ).normalize();

    return new THREE.Matrix4(
        basisX.x, basisY.x, basisZ.x, 0,
        basisX.y, basisY.y, basisZ.y, 0,
        basisX.z, basisY.z, basisZ.z, 0,
        0, 0, 0, 1,
    );
}

/**
 * Utility to created a offset point by given vector & coeffcients.
 * e.g. offset(segBegin, [feedDir, segmentLength * 0.5], [normal, feedDepth * 0.5])
 * @param p Point to offset (readonly)
 * @param offsets List of vector & coefficient pairs
 * @returns Offset point (new instance)
 */
const offsetPoint = (p: THREE.Vector3, ...offsets: Array<[THREE.Vector3, number]>): THREE.Vector3 => {
    const ret = p.clone();
    const temp = new THREE.Vector3();
    for (const [v, k] of offsets) {
        ret.add(temp.copy(v).multiplyScalar(k));
    }
    return ret;
};


/**
 * Utility to create box shape from base point and axis specs.
 * @param base Base point
 * @param axisSpecs List of anchor ("center", "origin") & base vector & k. base vector * k must span full-size of the box.
 * @returns Box shape
 */
const createBoxShapeFrom = (base: THREE.Vector3, ...axisSpecs: Array<[string, THREE.Vector3, number]>): Shape => {
    if (axisSpecs.length !== 3) {
        throw "Invalid axis specs";
    }
    const center = new THREE.Vector3().copy(base);
    const halfVecs = [];
    for (const [anchor, vec, len] of axisSpecs) {
        const hv = vec.clone().multiplyScalar(len * 0.5);
        switch (anchor) {
            case "center":
                halfVecs.push(hv);
                break;
            case "origin":
                center.add(hv);
                halfVecs.push(hv);
                break;
            default:
                throw `Invalid anchor: ${anchor}`;
        }
    }
    return createBoxShape(center, halfVecs[0], halfVecs[1], halfVecs[2]);
};


/**
 * Generate tool geom, origin = tool tip. In Z+ direction, there will be tool base marker.
 * @returns Tool visualization object
 */
const generateTool = (toolLength: number, toolDiameter: number): THREE.Object3D => {
    const toolOrigin = new THREE.Object3D();

    const toolRadius = toolDiameter / 2;
    const baseRadius = 5;

    // note: cylinder geom is Y direction and centered. Need to rotate and shift.

    const tool = new THREE.Mesh(
        new THREE.CylinderGeometry(toolRadius, toolRadius, toolLength, 32, 1),
        new THREE.MeshPhysicalMaterial({ color: 0xf0f0f0, metalness: 0.9, roughness: 0.3, wireframe: true }));
    tool.setRotationFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    tool.position.z = toolLength / 2;

    const toolBase = new THREE.Mesh(
        new THREE.CylinderGeometry(baseRadius, baseRadius, 0, 6, 1),
        new THREE.MeshPhysicalMaterial({ color: 0xe0e0e0, metalness: 0.2, roughness: 0.8, wireframe: true }));
    toolBase.setRotationFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    toolBase.position.z = toolLength;
    toolOrigin.add(toolBase);

    toolOrigin.add(tool);
    return toolOrigin;
};

/**
 * Spark WG1 machine physical configuration.
 */
const sparkWg1Config = {
    toolNaturalDiameter: 3,
    toolNaturalLength: 25,

    workOffset: new THREE.Vector3(20, 40, 20), // in machine coords
    wireCenter: new THREE.Vector3(30, 15, 30),
    toolRemoverCenter: new THREE.Vector3(40, 10, 30),
    toolBankOrigin: new THREE.Vector3(20, 20, 15),
    stockCenter: new THREE.Vector3(10, 10, 10),


    /**
     * Computes tool base & work table pos from tip target.
     *
     * @param tipPos Tip position in work or machine coordinates (determined by isPosW)
     * @param tipNormalW Tip normal in work coordinates. Tip normal corresponds to work surface, and points towards tool holder
     * @param toolLength Tool length
     * @param isPosW True if tipPos is in work coordinates, false if in machine coordinates
     * @returns Machine coordinates and work coordinates
     *   - vals: Machine instructions for moving work table & tool base
     *   - tipPosM: Tip position in machine coordinates
     *   - tipPosW: Tip position in work coordinates
     */
    solveIk(tipPos: THREE.Vector3, tipNormalW: THREE.Vector3, toolLength: number, isPosW: boolean) {
        // Order of determination ("IK")
        // 1. Determine B,C axis
        // 2. Determine X,Y,Z axis
        // TODO: A-axis
        // (X,Y,Z) -> B * toolLen = tipPt

        const EPS_ANGLE = 1e-3 / 180 * Math.PI; // 1/1000 degree

        const n = tipNormalW.clone();
        if (n.z < 0) {
            console.error("Impossible tool normal; path will be invalid", n);
        }

        n.z = 0;
        const bAngle = Math.asin(n.length());
        let cAngle = 0;
        if (bAngle < EPS_ANGLE) {
            // Pure Z+. Prefer neutral work rot.
            cAngle = 0;
        } else {
            cAngle = -Math.atan2(n.y, n.x);
        }

        const tipPosM = tipPos.clone();
        const tipPosW = tipPos.clone();
        if (isPosW) {
            tipPosM.applyAxisAngle(new THREE.Vector3(0, 0, 1), cAngle);
            tipPosM.add(this.workOffset);
        } else {
            tipPosW.sub(this.workOffset);
            tipPosW.applyAxisAngle(new THREE.Vector3(0, 0, 1), -cAngle);
        }

        const offsetBaseToTip = new THREE.Vector3(-Math.sin(bAngle), 0, -Math.cos(bAngle)).multiplyScalar(toolLength);
        const tipBasePosM = tipPosM.clone().sub(offsetBaseToTip);

        return {
            vals: {
                x: tipBasePosM.x,
                y: tipBasePosM.y,
                z: tipBasePosM.z,
                b: bAngle,
                c: cAngle,
            },
            tipPosM: tipPosM,
            tipPosW: tipPosW,
        };
    }
};

/**
 * Utility to accumulate correct path for short-ish tool paths. (e.g. single sweep or part of it)
 */
class PartialPath {
    machineConfig: any;
    sweepIx: number;
    group: string;
    normal: Vector3;
    minToolLength: number;
    toolIx: number;
    toolLength: number;
    minSweepRemoveShapes: Shape[];
    maxSweepRemoveShapes: Shape[];
    path: PathSegment[];
    prevPtTipPos: Vector3 | null;

    /**
     * @param sweepIx - Sweep index
     * @param group - Group name
     * @param normal - Normal vector
     * @param minToolLength - Minimum tool length required. Can change later with 
     * @param toolIx - Tool index
     * @param toolLength - Current tool length
     * @param machineConfig - Target machine's physical configuration
     */
    constructor(sweepIx: number, group: string, normal: Vector3, minToolLength: number, toolIx: number, toolLength: number, machineConfig: any) {
        this.machineConfig = machineConfig;

        this.sweepIx = sweepIx;
        this.group = group;
        this.normal = normal;
        this.minToolLength = minToolLength;
        this.toolIx = toolIx;
        this.toolLength = toolLength;
        this.minSweepRemoveShapes = [];
        this.maxSweepRemoveShapes = [];
        this.path = [];
        this.prevPtTipPos = null; // work-coords

        this.updateMinToolLength(this.minToolLength);
    }

    /**
     * Update minimum tool length.
     * @param newMinToolLength New minimum tool length
     */
    updateMinToolLength(newMinToolLength: number) {
        if (this.machineConfig.toolNaturalLength < newMinToolLength) {
            throw "required min tool length impossible";
        }

        if (this.toolLength < newMinToolLength) {
            this.#changeTool();
            this.toolLength = this.machineConfig.toolNaturalLength;
        }
        this.minToolLength = newMinToolLength;
    }

    #withAxisValue(type: any, pt: any): PathSegment {
        const isPosW = pt.tipPosW !== undefined;
        const ikResult = this.machineConfig.solveIk(isPosW ? pt.tipPosW : pt.tipPosM, this.normal, this.toolLength, isPosW);
        return {
            ...pt,
            type,
            tipPosM: ikResult.tipPosM,
            tipPosW: ikResult.tipPosW,
            axisValues: ikResult.vals,
            sweep: this.sweepIx,
            group: this.group,
            tipNormalW: this.normal,
        };
    }

    /**
     * Discard given length of the tool. Replace to a new tool if necessary.
     * @param discardLength Length of the tool to discard
     */
    discardToolTip(discardLength: number) {
        const toolLenAfter = this.toolLength - discardLength;
        if (toolLenAfter < this.minToolLength) {
            this.#changeTool();
            this.toolIx++;
            this.toolLength = this.machineConfig.toolNaturalLength;
        } else {
            this.#grindTool(discardLength);
            this.toolLength -= discardLength;
        }
    }

    /**
     * Add tool-change movement.
     */
    #changeTool() {
        // TODO: proper collision avoidance
        // TODO: emit RICH_STATE

        // Remove current tool.
        {
            // go to tool remover
            this.path.push(this.#withAxisValue("move", {
                tipPosM: this.machineConfig.toolRemoverCenter,
            }));
            // execute "remove-tool" movement
            const pull = new THREE.Vector3(0, 0, 5);
            this.path.push(this.#withAxisValue("move", {
                tipPosM: offsetPoint(this.machineConfig.toolRemoverCenter, [pull, 1]),
            }));
        }

        this.toolIx++;

        // Get new tool.
        {
            // goto tool bank
            const bankToolDir = new THREE.Vector3(6, 0, 0);
            const bankPos = offsetPoint(this.machineConfig.toolBankOrigin, [bankToolDir, this.toolIx]);
            this.path.push(this.#withAxisValue("move", {
                tipPosM: bankPos,
            }));

            // execute "tool-insert" movement
            const push = new THREE.Vector3(0, 0, -5);
            this.path.push(this.#withAxisValue("move", {
                tipPosM: offsetPoint(bankPos, [push, 1]),
            }));
        }
    }

    /**
     * Add tool-grind movement.
     */
    #grindTool(discardLength: number) {
        // TODO: proper collision avoidance
        // TODO: offset by discardLength
        // TODO: emit RICH_STATE
        const up = new THREE.Vector3(1, 0, 0);

        // move below grinder 
        this.path.push(this.#withAxisValue("move", {
            tipPosM: offsetPoint(this.machineConfig.wireCenter, [up, -3]),
        }));
        // cut off the tool
        this.path.push(this.#withAxisValue("remove-tool", {
            tipPosM: offsetPoint(this.machineConfig.wireCenter, [up, 3]),
        }));
    }

    /**
     * Add non-material-removing move. (i.e. G0 move)
     * @param type label for this move
     * @param tipPos Tip position in work coordinates
     */
    nonRemove(type: string, tipPos: THREE.Vector3) {
        this.path.push(this.#withAxisValue(type, { tipPosW: tipPos }));
        this.prevPtTipPos = tipPos;
    }

    /**
     * Add min-shape without changing path.
     * This can be used when caller knows min-cut happens due to combination of multiple remove() calls,
     * but min-cut cannot be easily attributed to individual remove() calls separately.
     * @param shape Shape to add
     */
    addMinRemoveShape(shape: Shape) {
        this.minSweepRemoveShapes.push(shape);
    }

    /**
     * Add material-removing move. (i.e. G1 move) The move must be horizontal.
     * @param tipPos Tip position in work coordinates
     * @param toolRotDelta Tool rotation delta in radians
     * @param maxDiameter Maximum diameter of the tool
     * @param minDiameter Minimum diameter of the tool
     */
    removeHorizontal(tipPos: THREE.Vector3, toolRotDelta: number, maxDiameter: number, minDiameter: number) {
        if (this.prevPtTipPos === null) {
            throw "nonRemove() need to be called before removeHorizontal()";
        }
        if (tipPos.clone().sub(this.prevPtTipPos).dot(this.normal) !== 0) {
            throw "remove path needs to be horizontal (perpendicular to normal)";
        }

        if (minDiameter > 0) {
            this.minSweepRemoveShapes.push(createELHShape(this.prevPtTipPos, tipPos, this.normal, minDiameter / 2, 100));
        }
        this.maxSweepRemoveShapes.push(createELHShape(this.prevPtTipPos, tipPos, this.normal, maxDiameter / 2, 100));
        this.path.push(this.#withAxisValue("remove-work", { tipPosW: tipPos, toolRotDelta: toolRotDelta }));
        this.prevPtTipPos = tipPos;
    }

    /**
     * Add material-removing move. (i.e. G1 move) The move must be vertical.
     * @param tipPos Tip position in work coordinates
     * @param toolRotDelta Tool rotation delta in radians
     * @param diameter Diameter of the tool
     * @param uncutDepth Depth that might not be cut (reduce min cut by this)
     */
    removeVertical(tipPos: THREE.Vector3, toolRotDelta: number, diameter: number, uncutDepth: number) {
        if (this.prevPtTipPos === null) {
            throw "nonRemove() need to be called before removeVertical()";
        }
        if (tipPos.clone().sub(this.prevPtTipPos).cross(this.normal).length() !== 0) {
            throw "remove path needs to be vertical (parallel to normal)";
        }

        this.minSweepRemoveShapes.push(createCylinderShape(offsetPoint(tipPos, [this.normal, uncutDepth]), this.normal, diameter / 2, 200));
        this.maxSweepRemoveShapes.push(createCylinderShape(tipPos, this.normal, diameter / 2, 200));
        this.path.push(this.#withAxisValue("remove-work", {
            tipPosW: tipPos,
            toolRotDelta: toolRotDelta,
        }));
        this.prevPtTipPos = tipPos;
    }

    getPath() {
        return this.path;
    }

    getToolIx() {
        return this.toolIx;
    }

    getToolLength() {
        return this.toolLength;
    }

    getMaxRemoveShapes() {
        return this.maxSweepRemoveShapes;
    }

    getMinRemoveShapes() {
        return this.minSweepRemoveShapes;
    }
}

/**
 * Planner class for generating tool paths.
 *
 * This class is not pure function. It's a "module" with UIs and depends on debug stuff.
 * Thus, planner instance should be kept, even when re-running planner from scratch.
 */
export class ModulePlanner implements Module {
    framework: ModuleFramework;
    machineConfig: any;
    ewrMax: number;
    stockDiameter: number;
    workCRot: number;
    resMm: number;
    stockCutWidth: number;
    simWorkBuffer: number;
    showWork: boolean;
    targetSurf: any;
    numSweeps: number;
    showingSweep: number;
    removedVol: number;
    remainingVol: number;
    deviation: number;
    toolIx: number;
    toolLength: number;
    showPlanPath: boolean;
    highlightSweep: number;
    kernels: GpuKernels;
    //    trvg: TrackingVoxelGrid;
    planPath: PathSegment[];
    highlightGui: any;
    genSweeps: "continue" | "awaiting" | "none";
    baseZ: number;
    aboveWorkSize: number;
    gen: AsyncGenerator<"break" | undefined, void, unknown>;

    targetManifold: ManifoldHandle;
    stockManifold: ManifoldHandle;

    // View vector for mesh projection
    viewVectorX: number = 0;
    viewVectorY: number = 0;
    viewVectorZ: number = 1;

    wasmGeom: WasmGeom;

    /**
     * @param framework - ModuleFramework instance for visualization management
     */
    constructor(framework: ModuleFramework, wasmGeom: WasmGeom) {
        this.framework = framework;
        this.wasmGeom = wasmGeom;

        this.machineConfig = sparkWg1Config; // in future, there will be multiple options.

        // tool vis
        this.updateVisTransforms(new THREE.Vector3(-15, -15, 5), new THREE.Vector3(0, 0, 1), this.machineConfig.toolNaturalLength);

        // configuration
        this.ewrMax = 0.3;

        // machine-state setup
        this.stockDiameter = 15;
        this.workCRot = 0;

        this.resMm = 0.1;
        this.stockCutWidth = 1.0; // width of tool blade when cutting off the work.
        this.simWorkBuffer = 1.0; // extended bottom side of the work by this amount.

        this.showWork = true;
        this.targetSurf = null;

        this.numSweeps = 0;
        this.showingSweep = 0;
        this.removedVol = 0;
        this.remainingVol = 0;
        this.deviation = 0;
        this.toolIx = 0;
        this.toolLength = this.machineConfig.toolNaturalLength;
        this.showPlanPath = true;
        this.highlightSweep = 2;

        this.framework.registerModule(this);
    }

    /**
     * Add planner-specific GUI controls
     * @param gui GUI instance to add controls to
     */
    addGui(gui: GUI) {
        gui.add(this, "resMm", [0.01, 0.05, 0.1, 0.2, 0.5]);

        gui.add(this, "genAllSweeps");
        gui.add(this, "genNextSweep");
        gui.add(this, "numSweeps").disable().onChange(_ => {
            this.highlightGui.max(this.numSweeps);
        }).listen();
        gui.add(this, "removedVol").name("Removed Vol (㎣)").decimals(9).disable().listen();
        gui.add(this, "remainingVol").name("Remaining Vol (㎣)").decimals(9).disable().listen();
        gui.add(this, "deviation").name("Deviation (mm)").decimals(3).disable().listen();
        gui.add(this, "toolIx").disable().listen();
        gui.add(this, "showWork")
            .onChange(_ => this.framework.setVisVisibility("work", this.showWork))
            .listen();
        gui.add(this, "showPlanPath")
            .onChange(_ => this.framework.setVisVisibility("plan-path-vg", this.showPlanPath))
            .listen();
        this.highlightGui = gui.add(this, "highlightSweep", 0, 50, 1).onChange(_ => {
            if (!this.planPath) {
                return;
            }
            this.framework.updateVis("plan-path-vg", [createPathVis(this.planPath, this.highlightSweep)], this.showPlanPath);
        }).listen();

        // wasm-geom testers
        const projectionFolder = gui.addFolder("Mesh Projection");
        projectionFolder.add(this, "viewVectorX", -1, 1, 0.1).name("View X").listen();
        projectionFolder.add(this, "viewVectorY", -1, 1, 0.1).name("View Y").listen();
        projectionFolder.add(this, "viewVectorZ", -1, 1, 0.1).name("View Z").listen();
        projectionFolder.add(this, "randomizeViewVector").name("Randomize");
        projectionFolder.add(this, "projectMesh").name("Project");
    }

    animateHook() {
        if (this.genSweeps === "continue") {
            this.genSweeps = "awaiting";
            (async () => {
                const status = await this.genNextSweep();
                if (status === "done") {
                    this.genSweeps = "none";
                } else if (status === "break") {
                    this.genSweeps = "none";
                    console.log("break requested");
                } else if (status === "continue") {
                    this.genSweeps = "continue";
                }
            })();
        }
    }

    updateVisTransforms(tipPos, tipNormal, toolLength) {
        const tool = generateTool(toolLength, this.machineConfig.toolNaturalDiameter);
        this.framework.updateVis("tool", [tool], false);

        tool.position.copy(tipPos);
        tool.setRotationFromMatrix(createRotationWithZ(tipNormal));
    }

    /**
     * Setup new targets.
     *
     * @param targetSurf Target surface geometry
     * @param baseZ Z+ in machine coords where work coords Z=0 (bottom of the targer surface).
     * @param aboveWorkSize Length of stock to be worked "above" baseZ plane. Note below-baseZ work will be still removed to cut off the work.
     * @param stockDiameter Diameter of the stock.
     */
    initPlan(targetSurf: Float64Array, targetGeom: THREE.BufferGeometry, baseZ: number, aboveWorkSize: number, stockDiameter: number) {
        this.targetSurf = targetSurf; // TODO: want to deprecate
        if (this.targetManifold) {
            this.wasmGeom.destroyManifold(this.targetManifold);
        }
        this.targetManifold = this.wasmGeom.createManifold(targetGeom);
        this.stockDiameter = stockDiameter;
        this.baseZ = baseZ;
        this.aboveWorkSize = aboveWorkSize;
        this.gen = this.#pathGenerator();
    }

    genAllSweeps() {
        this.genSweeps = "continue"; // "continue" | "awaiting" | "none"
    }

    /**
     * Generate the next sweep.
     * @returns "done": gen is done. "break": gen requests breakpoint for debug, restart needs manual intervention. "continue": gen should be continued.
     */
    async genNextSweep(): Promise<"done" | "break" | "continue"> {
        if (!this.gen) {
            this.gen = this.#pathGenerator();
        }
        const res = await this.gen.next();
        if (res.done) {
            return "done";
        }
        return (res.value === "break") ? "break" : "continue";
    }

    /**
     * Generates path.
     * Path = [sweep]. Each sweep is generated by {@link genPlanarSweep}, {@link genDrillSweep} etc.
     * Sweep is basic unit of path. To make them composable, following properties must be met, as pre/post-conditions:
     * - Tool is not touching work nor grinder
     * - De-energized
     * - Tool shape is prestine (have original tool diameter). Tool length can differ from original.
     * 
     * Yields "break" to request pausing execution for debug inspection.
     * Otherwise yields undefined to request an animation frame before continuing.
     */
    async *#pathGenerator(): AsyncGenerator<"break" | undefined, void, unknown> {
        const t0 = performance.now();

        ////////////////////////////////////////
        // Init

        if (!this.kernels) {
            throw new Error('WebGPU not supported; cannot start path generation');
        }

        this.numSweeps = 0;
        this.removedVol = 0;
        this.toolIx = 0;
        this.toolLength = this.machineConfig.toolNaturalLength;

        const simStockLength = this.stockCutWidth + this.simWorkBuffer + this.aboveWorkSize;
        const stockGeom = generateStockGeom(this.stockDiameter / 2, simStockLength);
        translateGeom(stockGeom, new THREE.Vector3(0, 0, -(this.stockCutWidth + this.simWorkBuffer)));
        //const stockSurf = convGeomToSurf(stockGeom);
        this.stockManifold = this.wasmGeom.createManifold(stockGeom);
        /*
        const workVg = initVGForPoints(this.stockSurf, this.resMm);
        const targVg = workVg.clone();
        const tst = performance.now();
        diceSurf(this.stockSurf, workVg);
        console.log(`diceSurf took ${performance.now() - tst}ms`);
        const ttg = performance.now();
        diceSurf(this.targetSurf, targVg);
        console.log(`diceSurf took ${performance.now() - ttg}ms`);
        console.log(`stock: ${workVg.volume()} mm^3 (${workVg.countIf(v => v > 0).toLocaleString("en-US")} voxels) / target: ${targVg.volume()} mm^3 (${targVg.countIf(v => v > 0).toLocaleString("en-US")} voxels)`);
        */

        //this.trvg = new TrackingVoxelGrid(this.kernels);
        /*
        await this.trvg.setFromWorkAndTarget(workVg, targVg);
        await this.trvg.setProtectedWorkBelowZ(-this.stockCutWidth);
        */

        this.planPath = [];
        //const workDev = this.trvg.extractWorkWithDeviation();
        //this.framework.updateVis("work-vg", [await createDeviationVis(this.kernels, workDev)], this.showWork);
        //this.kernels.destroy(workDev);
        //this.framework.updateVis("targ-vg", [createOccupancyVis(await this.trvg.extractTarget())], this.showTarget);
        this.framework.updateVis("plan-path-vg", [createPathVis(this.planPath)], this.showPlanPath);


        ////////////////////////////////////////
        // Main Loop

        const feedDepth = 1; // TODO: reduce later. current values allow fast debug, but too big for actual use.

        // TODO: augment this from model normal features?
        let candidateNormals = [
            new THREE.Vector3(1, 0, 0),
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(-1, 0, 0),
            new THREE.Vector3(0, -1, 0),
            new THREE.Vector3(0, 0, 1),
        ];

        /**
         * Verify and commit sweep.
         * @param sweep Sweep to commit
         * @returns true if committed, false if rejected.
         * @async
         */
        const tryCommitSweep = async (sweep: Sweep) => {
            console.log("old tryCommitSweep", sweep);
        };

        // rough removals
        // TODO: implement!!!

        yield "break";

        // not done, but out of choices
        const dt = performance.now() - t0;
        console.log(`possible sweep exhausted after ${dt / 1e3}sec (${dt / this.numSweeps}ms/sweep)`);
    }

    /**
     * Generate sphere geometry
     * @param radius Sphere radius
     * @returns Sphere geometry
     */
    private generateSphereGeometry(radius: number): THREE.BufferGeometry {
        const geom = new THREE.SphereGeometry(radius, 32, 16);
        geom.translate(1, 0, 0);
        return geom;
    }

    /**
     * High-level mesh projection with visualization and error handling
     */
    async projectMesh() {
        const simStockLength = this.stockCutWidth + this.simWorkBuffer + this.aboveWorkSize;
        const stockGeom = generateStockGeom(this.stockDiameter / 2, simStockLength);
        translateGeom(stockGeom, new THREE.Vector3(0, 0, -(this.stockCutWidth + this.simWorkBuffer)));
        this.stockManifold = this.wasmGeom.createManifold(stockGeom);

        const viewVectors = [
            // No AB-stage yet
            new THREE.Vector3(0, 1, 0),

            //new THREE.Vector3(0, 0, 1),
            // crosses
            //new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0),
            // diagonals
            //new THREE.Vector3(1, 1, 0).normalize(), new THREE.Vector3(1, -1, 0).normalize(),
        ];

        for (const viewVector of viewVectors) {


            // Create and validate view vector
            //const viewVector = new THREE.Vector3(this.viewVectorX, this.viewVectorY, this.viewVectorZ);
            /*
            if (viewVector.length() < 0.001) {
                throw new Error("View vector too small");
            }
                */

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
            let contour0 = this.wasmGeom.projectManifold(this.targetManifold, origin, viewX, viewY, viewZ);
            // contour0 = this.wasmGeom.outermostCrossSection(contour0);
            for (const offset of offsets) {
                const toolCenterContour = this.wasmGeom.offsetCrossSection(contour0, offset);
                contours = [...contours, this.wasmGeom.crossSectionToContours(toolCenterContour)];

                const innerContour = this.wasmGeom.offsetCrossSectionCircle(toolCenterContour, -toolRadius, 32);
                const cutCS = this.wasmGeom.createSquareCrossSection(100); // big enough to contain both work and target.
                const removeCS = this.wasmGeom.subtractCrossSection(cutCS, innerContour);
                const removeMani = this.wasmGeom.extrude(removeCS, viewX, viewY, viewZ, viewZ.clone().multiplyScalar(-50), 100); // 100mm should be big enough
                const actualRemovedMani = this.wasmGeom.intersectMesh(this.stockManifold, removeMani);
                console.log("removed volume", this.wasmGeom.volumeManifold(actualRemovedMani));
                this.stockManifold = this.wasmGeom.subtractMesh(this.stockManifold, removeMani); // update
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
                const mesh = new THREE.Mesh(this.wasmGeom.manifoldToGeometry(this.stockManifold), material);
                this.framework.updateVis("work", [mesh]);
            }

            // visualize remaining
            if (false) {
                const material = new THREE.MeshPhysicalMaterial({
                    color: "red",
                    metalness: 0.1,
                    roughness: 0.8,
                    transparent: true,
                    wireframe: true,
                    opacity: 0.9,
                });
                const mesh = new THREE.Mesh(this.wasmGeom.manifoldToGeometry(this.wasmGeom.subtractMesh(this.stockManifold, this.targetManifold)), material);
                this.framework.updateVis("remaining", [mesh]);
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
            this.framework.updateVis("misc", contourObjects);

            const evacLength = 2;
            const insP = pathBase[0].clone().add(new THREE.Vector3(0, -evacLength, 0))
            pathBase.splice(0, 0, insP);

            const insQ = pathBase[pathBase.length - 1].clone().add(new THREE.Vector3(0, evacLength, 0))
            pathBase.push(insQ);

            const geom = new THREE.BufferGeometry().setFromPoints(pathBase);
            const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 2 }));
            this.framework.updateVis("path-base", [line], true);

            const safeZ = 60;
            const opZ = 40;

            const wrap = (type, x, y, z) => {
                return {
                    type: type,
                    axisValues: {
                        x: x,
                        y: y,
                        z: z,
                        b: 0,
                        c: 0,
                    },
                    // dummy
                    tipPosM: new THREE.Vector3(),
                    tipPosW: new THREE.Vector3(),
                    tipNormalW: new THREE.Vector3(),
                    sweep: 0,
                    group: "",
                };
            };

            this.planPath = [];
            this.planPath.push(wrap("move", insP.x, insP.y, safeZ));
            this.planPath.push(wrap("move", insP.x, insP.y, opZ));
            this.planPath = this.planPath.concat(pathBase.map(pt => wrap("remove-work", pt.x, pt.y, opZ)));
            this.planPath.push(wrap("move", insQ.x, insQ.y, safeZ));
        }
    }

    /**
     * Randomize view vector
     */
    randomizeViewVector() {
        // Generate random unit vector
        const vec = new THREE.Vector3();
        do {
            vec.set((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2);
        } while (vec.lengthSq() < 0.01);

        vec.normalize();
        this.viewVectorX = vec.x;
        this.viewVectorY = vec.y;
        this.viewVectorZ = vec.z;
    }
}
