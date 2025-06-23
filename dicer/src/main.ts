// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadFont, debug, visDot, visQuad } from './ui-base.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { N8AOPass } from '../vendor/n8ao/N8AO.js';
import { diceSurf } from './mesh.js';
import { createELHShape, createCylinderShape, createBoxShape, VoxelGridGpu, GpuKernels, Shape, Boundary } from './gpu-geom.js';
import { VoxelGridCpu } from './cpu-geom.js';
import { TrackingVoxelGrid, computeAABB, initVGForPoints } from './tracking-voxel.js';
import { Vector3 } from 'three';

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
const createOccupancyVis = (vg: VoxelGridCpu): THREE.Object3D => {
    if (vg.type !== "u32") {
        throw `Invalid vg type for occupancy: ${vg.type}`;
    }

    const t0 = performance.now();
    const cubeSize = vg.res * 1.0;
    const cubeGeom = new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize);

    const meshContainer = new THREE.Object3D();
    meshContainer.position.copy(vg.ofs);
    const axesHelper = new THREE.AxesHelper();
    axesHelper.scale.set(vg.res * vg.numX, vg.res * vg.numY, vg.res * vg.numZ);

    const meshFull = new THREE.InstancedMesh(cubeGeom, new THREE.MeshLambertMaterial(), vg.countIf(val => val === 255));
    const meshPartial = new THREE.InstancedMesh(cubeGeom, new THREE.MeshNormalMaterial({ transparent: true, opacity: 0.25 }), vg.countIf(val => val === 128));

    let instanceIxFull = 0;
    let instanceIxPartial = 0;
    for (let iz = 0; iz < vg.numZ; iz++) {
        for (let iy = 0; iy < vg.numY; iy++) {
            for (let ix = 0; ix < vg.numX; ix++) {
                const v = vg.get(ix, iy, iz);
                if (v === 0) {
                    continue;
                }

                // whatever different color gradient
                meshFull.setColorAt(instanceIxFull, new THREE.Color(ix * 0.01 + 0.5, iy * 0.01 + 0.5, iz * 0.01 + 0.5));

                const mtx = new THREE.Matrix4();
                mtx.compose(
                    new THREE.Vector3(ix, iy, iz).addScalar(0.5).multiplyScalar(vg.res),
                    new THREE.Quaternion(),
                    new THREE.Vector3(1, 1, 1).multiplyScalar(v === 255 ? 1.0 : 0.8));

                if (v === 255) {
                    meshFull.setMatrixAt(instanceIxFull, mtx);
                    instanceIxFull++;
                } else {
                    meshPartial.setMatrixAt(instanceIxPartial, mtx);
                    instanceIxPartial++;
                }
            }
        }
    }

    meshContainer.add(meshFull);
    meshContainer.add(meshPartial);
    meshFull.add(axesHelper);

    console.log(`  createOccupancyVis took ${performance.now() - t0}ms`);
    return meshContainer;
};

const initCreateDeviationVis = (kernels) => {
    // input: deviation (>=0: dev, -1: empty)
    // output: mask (1: visible, 0: hidden)
    // TODO: This uses lots of "hidden" impl detail of map. maybe better to move to voxel.js?
    kernels.registerMapFn("visible_dev_mask", "f32", "u32", `
        if (vi < 0) {
            vo = 0;
        } else if (any(index3 == vec3u(0)) || any(index3 + 1 == nums)) {
            vo = 1; // boundary voxel is visible regardless of neighbors.
        } else {
            let ofs = array<vec3i, 6>(
                vec3i(1, 0, 0),
                vec3i(-1, 0, 0),
                vec3i(0, 1, 0),
                vec3i(0, -1, 0),
                vec3i(0, 0, 1),
                vec3i(0, 0, -1),
            );
            var has_empty_neighbor = false;
            for (var i = 0u; i < 6u; i++) {
                let nix3 = vec3u(vec3i(index3) + ofs[i]);
                let nv = vs_in[compose_ix(nix3)];
                if (nv < 0) {
                    has_empty_neighbor = true;
                    break;
                }
            }
            // this voxel is visible through empty neighbor.
            vo = select(0u, 1u, has_empty_neighbor);
        }
    `);

    kernels.registerMapFn("cv_dev_data", "f32", "vec4f", `
        vo = vec4f(p, vi);
    `);

    kernels.registerMapFn("max_dev_mask", "f32", "u32", `
        vo = select(0u, 1u, vi >= max_dev);
    `, { max_dev: "f32" });
};

/**
 * Get max deviation from voxel grid.
 * @param kernels
 * @param vg f32 voxel grid
 * @returns Maximum deviation
 * @async
 */
const getMaxDeviation = async (kernels: GpuKernels, vg: VoxelGridGpu) => {
    return (await kernels.reduce("max", vg)) as number;
};

/**
 * Create deviation voxel grid visualization. (blue: 0 deviation, red: maxDev deviation)
 * @param kernels
 * @param vg Voxel grid to visualize (f32: >=0: deviation, -1: empty)
 * @param maxDev Maximum deviation to visualize.
 * @async
 */
const createDeviationVis = async (kernels: GpuKernels, vg: VoxelGridGpu, maxDev: number = 3): Promise<THREE.Object3D> => {
    if (vg.type !== "f32") {
        throw `Invalid vg type for deviation: ${vg.type}`;
    }

    const t0 = performance.now();

    const cubeSize = vg.res * 1.0;
    const cubeGeom = new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize);

    const resultVis = new THREE.Object3D();
    const axesHelper = new THREE.AxesHelper();
    axesHelper.scale.set(vg.res * vg.numX, vg.res * vg.numY, vg.res * vg.numZ);
    axesHelper.position.copy(vg.ofs);

    // Extract visible voxels.
    const maskVg = kernels.createLike(vg, "u32");
    const dataVg = kernels.createLike(vg, "vec4f");
    kernels.map("visible_dev_mask", vg, maskVg);
    kernels.map("cv_dev_data", vg, dataVg);
    const numVisible = (await kernels.reduce("sum", maskVg)) as number;
    const packedResultBuf = kernels.createBuffer(16 * numVisible);
    kernels.packRaw(maskVg, dataVg, packedResultBuf);
    const packedResultBufCpu = new ArrayBuffer(16 * numVisible);
    await kernels.copyBuffer(packedResultBuf, packedResultBufCpu);
    packedResultBuf.destroy();
    kernels.destroy(maskVg);
    kernels.destroy(dataVg);

    // Transform them into InstancedMesh.
    const mesh = new THREE.InstancedMesh(cubeGeom, new THREE.MeshLambertMaterial(), numVisible);
    const resultArr = new Float32Array(packedResultBufCpu); // px, py, pz, dev
    const mtx = new THREE.Matrix4();
    const col = new THREE.Color();
    for (let i = 0; i < numVisible; i++) {
        // set position
        mtx.makeTranslation(resultArr[i * 4 + 0], resultArr[i * 4 + 1], resultArr[i * 4 + 2]);
        mesh.setMatrixAt(i, mtx);

        // set color, from blue(dev=0) to red(dev=maxDev).
        const dev = resultArr[i * 4 + 3];
        const t = Math.min(1, dev / maxDev);
        mesh.setColorAt(i, col.setRGB(0.2 + t * 0.8, 0.2, 0.2 + (1 - t) * 0.8));
    }

    resultVis.add(mesh);
    resultVis.add(axesHelper);

    console.log(`  createDeviationVis took ${performance.now() - t0}ms`);
    return resultVis;
};

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

/**
 * Visualize tool tip path in machine coordinates.
 *
 * @param path Array of path segments
 * @param highlightSweep If specified, highlight this sweep.
 * @returns Path visualization object
 */
const createPathVis = (path: Array<THREE.Vector3>, highlightSweep: number = -1): THREE.Object3D => {
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
 * Generate stock visualization.
 * @param stockRadius Radius of the stock
 * @param stockHeight Height of the stock
 * @param baseZ Z+ in machine coords where work coords Z=0 (bottom of the targer surface).
 * @returns Stock visualization object
 */
const generateStock = (stockRadius: number = 7.5, stockHeight: number = 15, baseZ: number = 0): THREE.Object3D => {
    const stock = new THREE.Mesh(
        generateStockGeom(stockRadius, stockHeight),
        new THREE.MeshLambertMaterial({ color: "blue", wireframe: true, transparent: true, opacity: 0.05 }));
    stock.position.z = -baseZ;
    return stock;
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
    minSweepRemoveShapes: any[];
    maxSweepRemoveShapes: any[];
    path: any[];
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

    #withAxisValue(type, pt) {
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
    #grindTool(discardLength) {
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
 * Interface for modules that can be registered with ModuleFramework
 */
interface Module {
    animateHook?(): void;
}

/**
 * Planner class for generating tool paths.
 *
 * This class is not pure function. It's a "module" with UIs and depends on debug stuff.
 * Thus, planner instance should be kept, even when re-running planner from scratch.
 */
class ModulePlanner implements Module {
    framework: ModuleFramework;
    machineConfig: any;
    ewrMax: number;
    stockDiameter: number;
    workCRot: number;
    resMm: number;
    stockCutWidth: number;
    simWorkBuffer: number;
    showWork: boolean;
    showTarget: boolean;
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
    trvg: TrackingVoxelGrid;
    planPath: any[];
    highlightGui: any;
    genSweeps: any;
    baseZ: number;
    aboveWorkSize: number;
    gen: any;
    stockSurf: any;

    /**
     * @param framework - ModuleFramework instance for visualization management
     */
    constructor(framework: ModuleFramework) {
        this.framework = framework;

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
        this.showTarget = false;
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

        if (!navigator.gpu) {
            throw new Error('WebGPU not supported');
        }
        (async () => {
            const adapter = await navigator.gpu.requestAdapter();
            this.kernels = new GpuKernels(await adapter.requestDevice());
            initCreateDeviationVis(this.kernels);
        })();
    }

    /**
     * @param gui lilgui instance
     */
    guiHook(gui: any) {
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
        gui.add(this, "showTarget")
            .onChange(_ => this.framework.setVisVisibility("targ-vg", this.showTarget))
            .listen();
        gui.add(this, "showWork")
            .onChange(_ => this.framework.setVisVisibility("work-vg", this.showWork))
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
    initPlan(targetSurf: THREE.BufferGeometry, baseZ: number, aboveWorkSize: number, stockDiameter: number) {
        this.targetSurf = targetSurf;
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
    async *#pathGenerator() {
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
        this.stockSurf = convGeomToSurf(stockGeom);
        const workVg = initVGForPoints(this.stockSurf, this.resMm);
        const targVg = workVg.clone();
        const tst = performance.now();
        diceSurf(this.stockSurf, workVg);
        console.log(`diceSurf took ${performance.now() - tst}ms`);
        const ttg = performance.now();
        diceSurf(this.targetSurf, targVg);
        console.log(`diceSurf took ${performance.now() - ttg}ms`);
        console.log(`stock: ${workVg.volume()} mm^3 (${workVg.countIf(v => v > 0).toLocaleString("en-US")} voxels) / target: ${targVg.volume()} mm^3 (${targVg.countIf(v => v > 0).toLocaleString("en-US")} voxels)`);

        this.trvg = new TrackingVoxelGrid(this.kernels);
        await this.trvg.setFromWorkAndTarget(workVg, targVg);
        await this.trvg.setProtectedWorkBelowZ(-this.stockCutWidth);

        this.planPath = [];
        const workDev = this.trvg.extractWorkWithDeviation();
        this.framework.updateVis("work-vg", [await createDeviationVis(this.kernels, workDev)], this.showWork);
        this.kernels.destroy(workDev);
        this.framework.updateVis("targ-vg", [createOccupancyVis(await this.trvg.extractTarget())], this.showTarget);
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
        const tryCommitSweep = async (sweep: {partialPath: PartialPath, ignoreOvercutErrors: boolean}) => {
            const t0 = performance.now();
            try {
                const volRemoved = await this.trvg.commitRemoval(
                    sweep.partialPath.getMinRemoveShapes(),
                    sweep.partialPath.getMaxRemoveShapes(),
                    sweep.ignoreOvercutErrors ?? false
                );
                if (volRemoved === 0) {
                    console.log("commit rejected, because work not removed");
                    return false;
                } else {
                    console.log(`commit sweep-${this.numSweeps} success`);
                    // commit success
                    this.removedVol += volRemoved;
                    this.remainingVol = await this.trvg.getRemainingWorkVol();
                    this.planPath.push(...sweep.partialPath.getPath());
                    this.toolIx = sweep.partialPath.getToolIx();
                    this.toolLength = sweep.partialPath.getToolLength();
                    this.numSweeps++;
                    this.highlightGui.max(this.numSweeps - 1); // ugly...
                    this.highlightSweep = this.numSweeps - 1;
                    this.showingSweep++;

                    // update visualizations
                    const workDeviation = this.trvg.extractWorkWithDeviation(true);
                    this.deviation = (await getMaxDeviation(this.kernels, workDeviation)) as number;
                    this.framework.updateVis("work-vg", [await createDeviationVis(this.kernels, workDeviation, this.deviation)], this.showWork);
                    this.framework.updateVis("work-max-dev", [await createMaxDeviationVis(this.kernels, workDeviation, this.deviation)]);
                    this.kernels.destroy(workDeviation);

                    this.framework.updateVis("plan-path-vg", [createPathVis(this.planPath, this.highlightSweep)], this.showPlanPath);
                    const lastPt = this.planPath[this.planPath.length - 1];
                    this.updateVisTransforms(lastPt.tipPosW, lastPt.tipNormalW, this.toolLength);

                    return true;
                }
            } finally {
                console.log(`tryCommitSweep: took ${performance.now() - t0}ms`);
            }
        };

        // rough removals
        for (const normal of candidateNormals) {
            let offset = (await this.trvg.queryWorkRange(normal)).max;
            console.log("Checking planar sweep viability", offset);

            // TODO: better termination condition
            while (offset > -50) {
                const sweep = await this.genPlanarSweep(normal, offset, this.machineConfig.toolNaturalDiameter, feedDepth);
                if (!sweep) {
                    break;
                }
                offset -= feedDepth;
                if (await tryCommitSweep(sweep)) {
                    yield;
                }
            }

            if (this.numSweeps >= 10) {
                const dtSec = (performance.now() - t0) / 1e3;
                console.log(`measurement milestone reached after ${dtSec}sec tot, ${dtSec / this.numSweeps}sec/sweep`);
                // return;
            }
        }

        yield "break";

        // rough drills
        for (const normal of candidateNormals) {
            const sweep = await this.genDrillSweep(normal, this.machineConfig.toolNaturalDiameter / 2);
            if (sweep) {
                if (await tryCommitSweep(sweep)) {
                    yield;
                }
            }
        }

        // part off
        const sweep = await this.genPartOffSweep();
        if (await tryCommitSweep(sweep)) {
            yield;
        }

        // not done, but out of choices
        const dt = performance.now() - t0;
        console.log(`possible sweep exhausted after ${dt / 1e3}sec (${dt / this.numSweeps}ms/sweep)`);
    }

    /**
     * Generate "planar sweep", directly below given plane.
     * Planer sweep only uses horizontal cuts.
     * 
     * @param normal Normal vector, in work coords. = tip normal
     * @param offset Offset from the plane. offset * normal forms the plane.
     * @param toolDiameter Tool diameter to use for this sweep.
     * @param feedDepth cut depth to use for this sweep.
     * @returns null if impossible
     * @async
     */
    async genPlanarSweep(normal: THREE.Vector3, offset: number, toolDiameter: number, feedDepth: number) {
        console.log(`genPlanarSweep: normal: (${normal.x}, ${normal.y}, ${normal.z}), offset: ${offset}, toolDiameter: ${toolDiameter}`);
        let t0True = performance.now();
        let t0 = performance.now();
        const normalRange = await this.trvg.queryWorkRange(normal);
        if (normalRange.max < offset) {
            throw "contradicting offset for genPlanarSweep";
        }
        const minToolLength = (normalRange.max - offset) + feedDepth;
        if (minToolLength > this.machineConfig.toolNaturalLength) {
            return null;
        }
        const sweepPath = new PartialPath(this.numSweeps, `sweep-${this.numSweeps}`, normal, minToolLength, this.toolIx, this.toolLength, this.machineConfig);

        const rot = createRotationWithZ(normal);
        const feedDir = new THREE.Vector3(1, 0, 0).transformDirection(rot);
        const rowDir = new THREE.Vector3(0, 1, 0).transformDirection(rot);
        const feedRange = await this.trvg.queryWorkRange(feedDir);
        const rowRange = await this.trvg.queryWorkRange(rowDir);
        console.log(`  queryWorkRange took ${performance.now() - t0}ms`);

        const maxHeight = normalRange.max - normalRange.min;

        const feedWidth = toolDiameter - this.resMm; // create little overlap, to remove undercut artifact caused by conservative minGeom computation.
        const segmentLength = 1;
        const discreteToolRadius = Math.ceil(toolDiameter / segmentLength / 2 - 0.5); // spans segments [-r, r].

        const margin = toolDiameter;
        const scanOrigin = offsetPoint(new THREE.Vector3(), [normal, offset], [feedDir, feedRange.min - margin], [rowDir, rowRange.min - margin]);
        const numRows = Math.ceil((rowRange.max - rowRange.min + 2 * margin) / feedWidth);
        const numSegs = Math.ceil((feedRange.max - feedRange.min + 2 * margin) / segmentLength);

        if (debug.log) {
            debug.vlog(visDot(scanOrigin, "black"));
            debug.vlog(visQuad(
                scanOrigin,
                rowDir.clone().multiplyScalar(feedWidth * numRows),
                feedDir.clone().multiplyScalar(segmentLength * numSegs),
                "gray"));
        }

        const segCenterBot = (ixRow, ixSeg) => {
            return offsetPoint(scanOrigin, [rowDir, feedWidth * ixRow], [feedDir, segmentLength * ixSeg], [normal, -feedDepth]);
        };

        await this.kernels.device.queue.onSubmittedWorkDone();
        t0 = performance.now();

        // rows : [row]
        // row : [segment]
        // segment : {
        //   segCenterBot: Vector3
        //   state: "blocked" | "work" | "empty" // blocked = contains non-cuttable bits, work = cuttable & has non-zero work, empty = accessible and no work
        // }
        const rows = new Array(numRows);
        const queries = [] as {shape: Shape, query: "blocked" | "has_work"}[];
        for (let ixRow = 0; ixRow < numRows; ixRow++) {
            rows[ixRow] = new Array(numSegs);
            for (let ixSeg = 0; ixSeg < numSegs; ixSeg++) {
                const segShapeAndAbove = createBoxShapeFrom(segCenterBot(ixRow, ixSeg), ["origin", normal, maxHeight], ["center", feedDir, segmentLength], ["center", rowDir, toolDiameter]);
                const segShape = createBoxShapeFrom(segCenterBot(ixRow, ixSeg), ["origin", normal, feedDepth], ["center", feedDir, segmentLength], ["center", rowDir, toolDiameter]);
                // Maybe should check any-non work for above, instead of blocked?
                // even if above region is cuttable, it will alter tool state unexpectedly.
                // Current logic only works correctly if scan pattern is same for different offset.
                const qixBlocked = queries.length;
                queries.push({ shape: segShapeAndAbove, query: "blocked" });
                const qixHasWork = queries.length;
                queries.push({ shape: segShape, query: "has_work" });
                rows[ixRow][ixSeg] = { qixBlocked, qixHasWork };
            }
        }
        const queryResults = await this.trvg.parallelQuery(queries);
        for (let ixRow = 0; ixRow < numRows; ixRow++) {
            for (let ixSeg = 0; ixSeg < numSegs; ixSeg++) {
                const { qixBlocked, qixHasWork } = rows[ixRow][ixSeg];
                const isBlocked = queryResults[qixBlocked];
                const hasWork = queryResults[qixHasWork];
                const state = isBlocked ? "blocked" : (hasWork ? "work" : "empty");
                rows[ixRow][ixSeg] = state;

                if (debug.log) {
                    let color;
                    if (state === "blocked") {
                        color = hasWork ? "orange" : "red";
                    } else if (state === "work") {
                        color = "green";
                    } else {
                        color = "gray";
                    }
                    debug.vlog(visDot(segCenterBot(ixRow, ixSeg), color));
                }
            }
        }
        console.log(`  shape queries took ${performance.now() - t0}ms`);

        // From segemnts, create "scans".
        // Scan will end at scanEndBot = apBot + scanDir * scanLen. half-cylinder of toolDiameter will extrude from scanEndBot at max.
        const scans = []; // {apBot, scanDir, scanLen}
        for (let ixRow = 0; ixRow < rows.length; ixRow++) {
            const row = rows[ixRow];
            const safeGet = (ix) => {
                if (ix < 0 || ix >= row.length) {
                    return "empty";
                }
                return row[ix];
            };
            const isAccessOk = (ix) => {
                if (ix < 0 || ix >= row.length) {
                    return false;
                }
                for (let dix = -discreteToolRadius; dix <= discreteToolRadius; dix++) {
                    if (safeGet(ix + dix) !== "empty") {
                        return false;
                    }
                }
                return true;
            };
            const isBlockedAround = (ix) => {
                for (let dix = -discreteToolRadius; dix <= discreteToolRadius; dix++) {
                    if (safeGet(ix + dix) === "blocked") {
                        return true;
                    }
                }
                return false;
            };
            const findMax = (arr, fn) => {
                let val = fn(arr[0]);
                let ix = 0;
                for (let i = 1; i < arr.length; i++) {
                    const v = fn(arr[i]);
                    if (v > val) {
                        val = v;
                        ix = i;
                    }
                }
                return arr[ix];
            };

            const scanCandidates = [];
            for (let ixBegin = 0; ixBegin < row.length; ixBegin++) {
                if (!isAccessOk(ixBegin)) {
                    continue;
                }

                // gather all valid right-scans.
                for (let len = 2; ; len++) {
                    const ixEnd = ixBegin + len;
                    if (ixEnd >= row.length || isBlockedAround(ixEnd)) {
                        break;
                    }

                    const workIxs = [];
                    for (let i = ixBegin + 1; i < ixEnd; i++) {
                        if (row[i] === "work") {
                            workIxs.push(i);
                        }
                    }
                    scanCandidates.push({ dir: "+", ixBegin, len, workIxs: new Set(workIxs) });
                }

                // gather all valid left-scans.
                for (let len = 2; ; len++) {
                    const ixEnd = ixBegin - len;
                    if (ixEnd < 0 || isBlockedAround(ixEnd)) {
                        break;
                    }

                    const workIxs = [];
                    for (let i = ixBegin - 1; i > ixEnd; i--) {
                        if (row[i] === "work") {
                            workIxs.push(i);
                        }
                    }
                    scanCandidates.push({ dir: "-", ixBegin, len, workIxs: new Set(workIxs) });
                }
            }

            if (scanCandidates.length === 0) {
                continue;
            }

            // Greedy-pick valid scans that maximizes workIx coverage but minimize total len.
            let unsatWorkIxs = new Set();
            for (let ix = 0; ix < row.length; ix++) {
                if (row[ix] === "work") {
                    unsatWorkIxs.add(ix);
                }
            }

            const BIGGER_THAN_ANY_LEN = 1000;
            const rowScans = [];
            while (unsatWorkIxs.size > 0) {
                const bestScan = findMax(scanCandidates, scan => {
                    const gain = scan.workIxs.intersection(unsatWorkIxs).size;
                    const score = gain * BIGGER_THAN_ANY_LEN - scan.len;
                    return score;
                });
                if (bestScan.workIxs.intersection(unsatWorkIxs).size === 0) {
                    break; // best scan adds nothing
                }
                unsatWorkIxs = unsatWorkIxs.difference(bestScan.workIxs);
                rowScans.push(bestScan);
            }

            for (const rs of rowScans) {
                scans.push({
                    apBot: segCenterBot(ixRow, rs.ixBegin),
                    scanDir: rs.dir === "+" ? feedDir : feedDir.clone().negate(),
                    scanLen: rs.len * segmentLength,
                    workSegNum: rs.workIxs.size,
                });
            }
        }

        // Execute scans one by one.
        const feedDepthWithExtra = feedDepth + this.resMm * 2; // treat a bit of extra is weared to remove any weird effect, both in real machine and min-cut simulation.
        const evacuateOffset = normal.clone().multiplyScalar(3);

        let remainingToolArea = 1; // keep remaining bit of tool for next scan.
        for (const scan of scans) {
            const endBot = offsetPoint(scan.apBot, [scan.scanDir, scan.scanLen]);

            // When tool rotation=0 and pushed forward, following things happen in order:
            // 1. Front semi-circle area is consumed first (mostly). During this time, cut diameter is exactly toolDiameter.
            //      - "mostly": sometimes, even when front semi-circle is available, side of the tool start to erode.
            // 2. Back semi-circle area is consumed. Cut diameter gradually decreases to 0.
            // to cut the rectangular work area, we at least need to keep 0.5 (hemi-circle) of tool, when reaching scan end point.
            const needToKeep = 0.6; // 0.5 is theoretical min. extra will be buffers.
            const scanWorkArea = scan.workSegNum * segmentLength * toolDiameter;
            const toolArea = Math.PI * (toolDiameter / 2) ** 2;
            let areaConsumption = scanWorkArea * this.ewrMax / toolArea + needToKeep;
            const numScans = Math.ceil(areaConsumption);

            // This is most basic path.
            // In reality, we don't need to go back to beginning nor go to end every time.
            // We can also continue using weared tool in next scan w/o refresh.
            for (let i = 0; i < numScans; i++) {
                // Ensure scan is done with full tool.
                if (remainingToolArea < 1) {
                    sweepPath.discardToolTip(feedDepthWithExtra);
                    remainingToolArea = 1;
                }

                sweepPath.nonRemove("move-in", scan.apBot.clone().add(evacuateOffset));
                sweepPath.nonRemove("move-in", scan.apBot);
                sweepPath.removeHorizontal(endBot, 0, toolDiameter, 0); // minDia=0, because we don't know min-cut during repeated scan.
                sweepPath.nonRemove("move-out", endBot.clone().add(evacuateOffset));

                if (areaConsumption > 1) {
                    remainingToolArea--;
                    areaConsumption--;
                } else {
                    remainingToolArea -= areaConsumption;
                    areaConsumption = 0;
                }
            }
            if (areaConsumption > 0) {
                throw "numScan computation bug";
            }
            // after enough number of scans, we know min-cut covers rectangular region.
            sweepPath.addMinRemoveShape(createBoxShapeFrom(scan.apBot, ["origin", normal, feedDepthWithExtra], ["origin", scan.scanDir, scan.scanLen], ["center", rowDir, toolDiameter]));
        }
        // clean tool to prestine state to satisfy sweep composability.
        if (remainingToolArea < 0) {
            sweepPath.discardToolTip(feedDepthWithExtra);
        }

        console.log(`genPlanarSweep: took ${performance.now() - t0True}ms`);
        if (sweepPath.getPath().length === 0) {
            return null;
        }
        return {
            partialPath: sweepPath,
            ignoreOvercutErrors: false,
        };
    }

    /**
     * Generate "drill sweep", axis=normal. Single drill sweep is single hole.
     * 
     * @param normal Normal vector, in work coords. = tip normal
     * @param toolDiameter Tool diameter to use for this sweep.
     * @returns null if impossible
     * @async
     */
    async genDrillSweep(normal: THREE.Vector3, toolDiameter: number) {
        console.log(`genDrillSweep: normal: (${normal.x}, ${normal.y}, ${normal.z}), toolDiameter: ${toolDiameter}`);
        const t0 = performance.now();

        const normalRange = await this.trvg.queryWorkRange(normal);
        const depthDelta = toolDiameter;
        const maxDepth = normalRange.max - normalRange.min;
        const holeDiameter = toolDiameter * 1.1;

        const sweepPath = new PartialPath(this.numSweeps, `sweep-${this.numSweeps}`, normal, 0, this.toolIx, this.toolLength, this.machineConfig);

        const rot = createRotationWithZ(normal);
        const scanDir0 = new THREE.Vector3(1, 0, 0).transformDirection(rot);
        const scanDir1 = new THREE.Vector3(0, 1, 0).transformDirection(rot);
        const scanRange0 = await this.trvg.queryWorkRange(scanDir0);
        const scanRange1 = await this.trvg.queryWorkRange(scanDir1);

        const scanRes = toolDiameter * 0.5;
        // +depthDelta: ensure initial position is unoccupied
        const scanOrigin = offsetPoint(new THREE.Vector3(), [scanDir0, scanRange0.min], [scanDir1, scanRange1.min], [normal, normalRange.max + depthDelta]);
        const numScan0 = Math.ceil((scanRange0.max - scanRange0.min) / scanRes);
        const numScan1 = Math.ceil((scanRange1.max - scanRange1.min) / scanRes);
        const numScanDepth = Math.ceil(maxDepth / depthDelta);

        // grid query for drilling
        // if ok, just drill it with helical downwards path.
        const drillHoleQs = [];
        const queries = [] as {shape: Shape, query: "blocked" | "has_work"}[];
        for (let ixScan0 = 0; ixScan0 < numScan0; ixScan0++) {
            for (let ixScan1 = 0; ixScan1 < numScan1; ixScan1++) {
                const scanPt = offsetPoint(scanOrigin, [scanDir0, scanRes * ixScan0], [scanDir1, scanRes * ixScan1]);
                const qixsBlocked = [];
                const qixsHasWork = [];
                for (let ixScanDepth = 0; ixScanDepth < numScanDepth; ixScanDepth++) {
                    // holeTopDepth = -depthDelta * ixScanDepth
                    const holeBot = offsetPoint(scanPt, [normal, -depthDelta * (1 + ixScanDepth)]);
                    const holeShape = createCylinderShape(holeBot, normal, holeDiameter / 2, depthDelta);

                    const qixBlocked = queries.length;
                    queries.push({ shape: holeShape, query: "blocked" });
                    const qixHasWork = queries.length;
                    queries.push({ shape: holeShape, query: "has_work" });

                    qixsBlocked.push(qixBlocked);
                    qixsHasWork.push(qixHasWork);
                }
                drillHoleQs.push({ scanPt, qixsBlocked, qixsHasWork });
            }
        }
        console.log(`  genDrillSweep: #holeCandidates=${drillHoleQs.length}, #queries=${queries.length}`);
        const queryResults = await this.trvg.parallelQuery(queries);

        const drillHoles = [];
        for (const hole of drillHoleQs) {
            // Find begin depth.
            let currDepthIx = 0;
            let depthBegin = null;
            while (currDepthIx < numScanDepth) {
                const blocked = queryResults[hole.qixsBlocked[currDepthIx]];
                const hasWork = queryResults[hole.qixsHasWork[currDepthIx]];

                if (blocked) {
                    break; // this location was no good (no work before being blocked)
                }
                if (hasWork) {
                    depthBegin = depthDelta * currDepthIx; // good begin depth = holeTop
                    break;
                }
                currDepthIx++;
            }
            if (depthBegin === null) {
                if (debug.log) {
                    debug.vlog(visDot(hole.scanPt, "gray"));
                }
                continue;
            }

            // Find end depth.
            currDepthIx++;
            let depthEnd = depthDelta * numScanDepth;
            while (currDepthIx < numScanDepth) {
                const blocked = queryResults[hole.qixsBlocked[currDepthIx]];
                const hasWork = queryResults[hole.qixsHasWork[currDepthIx]];
                // TODO: this can stop too early (when holes span multiple separate layers).
                if (blocked || !hasWork) {
                    depthEnd = depthDelta * currDepthIx; // end = holeTop
                    break;
                }
                currDepthIx++;
            }

            const holeTop = offsetPoint(hole.scanPt, [normal, -depthBegin]);
            const holeBot = offsetPoint(hole.scanPt, [normal, -depthEnd]);
            if (debug.log) {
                debug.vlog(visDot(holeTop, "red"));
                debug.vlog(visDot(holeBot, "blue"));
            }
            drillHoles.push({
                holeBot,
                holeTop,
            });
        }
        if (drillHoles.length === 0) {
            console.log(`genDrillSweep: took ${performance.now() - t0}ms`);
            return null;
        }

        // TODO: pick best hole (= removes most work)

        // Generate paths
        const evacuateOffset = normal.clone().multiplyScalar(3);

        drillHoles.forEach(hole => {
            sweepPath.nonRemove("move-in", hole.holeTop.clone().add(evacuateOffset));
            // TODO: helical path
            // TODO: wear handling
            // TODO: proper min-cut
            sweepPath.removeVertical(hole.holeBot, 0, toolDiameter, toolDiameter);
            sweepPath.nonRemove("move-out", hole.holeTop.clone().add(evacuateOffset));
        });

        console.log(`genDrillSweep: took ${performance.now() - t0}ms`);
        return {
            partialPath: sweepPath,
            ignoreOvercutErrors: false,
        };
    };

    /**
     * Generate "part off" sweep.
     * @returns Partial path with overcut error settings
     * @async
     */
    async genPartOffSweep() {
        // TODO: use rectangular tool for efficiency.
        // for now, just use circular tool because impl is simpler.
        const normal = new THREE.Vector3(1, 0, 0);
        const cutDir = new THREE.Vector3(0, 1, 0);

        const ctRange = await this.trvg.queryWorkRange(cutDir);
        const nrRange = await this.trvg.queryWorkRange(normal);
        const cutOffset = new THREE.Vector3(0, 0, -this.stockCutWidth * 0.5); // center of cut path

        const minToolLength = nrRange.max - nrRange.min;
        console.log(`minToolLength: ${minToolLength}`);
        const sweepPath = new PartialPath(this.numSweeps, `sweep-${this.numSweeps}`, normal, minToolLength, this.toolIx, this.toolLength, this.machineConfig);

        const ptBeginBot = offsetPoint(cutOffset, [cutDir, ctRange.min], [normal, nrRange.min]);
        const ptEndBot = offsetPoint(cutOffset, [cutDir, ctRange.max], [normal, nrRange.min]);

        sweepPath.nonRemove("move-in", ptBeginBot);
        sweepPath.removeHorizontal(ptEndBot, 123, this.stockCutWidth, this.stockCutWidth);

        return {
            partialPath: sweepPath,
            ignoreOvercutErrors: true,
        };
    }
}




/**
 * Framework for modules by combining three.js canvas & lil-gui.
 * Scene is in mm unit. Right-handed, X+ up. Work-coordinates.
 */
class ModuleFramework {
    // Three.js core objects
    camera: any;
    renderer: any;
    scene: any;
    composer: any;
    controls: any;
    stats: any;
    container: any;
    
    // Visualization management
    visGroups: any;
    
    // Debug logging
    vlogDebugs: any[];
    vlogErrors: any[];
    lastNumVlogErrors: number;
    vlogDebugEnable: boolean;
    vlogDebugShow: boolean;
    
    // Rendering settings
    renderAoRadius: number;
    renderDistFallOff: number;
    renderAoItensity: number;
    renderAoScreenRadius: boolean;

    // Module registry
    private modules: Array<Module> = [];

    constructor() {
        // Initialize basis
        this.init();

        this.visGroups = {};

        this.vlogDebugs = [];
        this.vlogErrors = [];
        this.lastNumVlogErrors = 0;

        // Visually log debug info.
        // [in] obj: THREE.Object3D
        debug.vlog = (obj) => {
            if (this.vlogDebugs.length > 1000000) {
                console.warn("vlog: too many debugs, cannot log more");
                return;
            }
            this.vlogDebugs.push(obj);
            this.addVis("vlog-debug", [obj], this.vlogDebugShow);
        };

        // Visually log errors.
        // [in] obj: THREE.Object3D
        debug.vlogE = (obj) => {
            if (this.vlogErrors.length > 1000000) {
                console.warn("vlogE: too many errors, cannot log more");
                return;
            }
            this.vlogErrors.push(obj);
            this.scene.add(obj);
        };

        // Setup extra permanent visualization
        const gridHelperBottom = new THREE.GridHelper(40, 4);
        gridHelperBottom.rotateX(Math.PI / 2);
        this.scene.add(gridHelperBottom);

        this.vlogDebugEnable = true;
        this.vlogDebugShow = false;

        this.renderAoRadius = 5;
        this.renderDistFallOff = 1.0;
        this.renderAoItensity = 5;
        this.renderAoScreenRadius = false;
    }

    init() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        const aspect = width / height;
        this.camera = new THREE.OrthographicCamera(-25 * aspect, 25 * aspect, 25, -25, 1, 150);
        this.camera.position.x = 15;
        this.camera.position.y = 40;
        this.camera.position.z = 20;
        this.camera.up.set(1, 0, 0);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(width, height);
        this.renderer.setAnimationLoop(() => this.animate());
        this.container = document.getElementById('container');
        this.container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xffffff);

        const light = new THREE.AmbientLight(0x808080); // soft white light
        this.scene.add(light);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(0, 0, 1);
        this.scene.add(directionalLight);

        const hemiLight = new THREE.HemisphereLight(0xffffbb, 0x080820, 1);
        this.scene.add(hemiLight);

        this.composer = new EffectComposer(this.renderer);
        const renderPass = new RenderPass(this.scene, this.camera);
        this.composer.addPass(renderPass);

        const n8aoPass = new N8AOPass(this.scene, this.camera, width, height);
        // We want "AO" effect to take effect at all scales, even though they're physically wrong.
        n8aoPass.configuration.screenSpaceRadius = true;
        n8aoPass.configuration.aoRadius = 64;
        n8aoPass.configuration.distanceFalloff = 0.2;
        n8aoPass.configuration.intensity = 5;
        this.composer.addPass(n8aoPass);

        const outputPass = new OutputPass();
        this.composer.addPass(outputPass);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);

        this.stats = new Stats();
        this.container.appendChild(this.stats.dom);

        const guiStatsEl = document.createElement('div');
        guiStatsEl.classList.add('gui-stats');

        window.addEventListener('resize', () => this.onWindowResize());
        Object.assign(window, { scene: this.scene });
    }

    clearVlogDebug() {
        this.vlogDebugs = [];
        this.updateVis("vlog-debug", this.vlogDebugs, this.vlogDebugShow);
    }

    /**
     * Register a module that has animateHook method
     */
    registerModule(module: Module) {
        this.modules.push(module);
    }

    /**
     * Visualization management
     */
    addVis(group: string, vs: Array<THREE.Object3D>, visible: boolean = true) {
        if (!this.visGroups[group]) {
            this.visGroups[group] = [];
            this.visGroups[group].visible = visible;
        }
        for (let v of vs) {
            this.visGroups[group].push(v);
            this.scene.add(v);
            v.visible = visible;
        }
    }

    updateVis(group: string, vs: Array<THREE.Object3D>, visible: boolean = true) {
        if (this.visGroups[group]) {
            this.visGroups[group].forEach(v => this.scene.remove(v));
        }
        this.visGroups[group] = vs;
        for (let v of vs) {
            this.scene.add(v);
            v.visible = visible;
        }
    }

    setVisVisibility(group: string, visible: boolean) {
        if (this.visGroups[group]) {
            this.visGroups[group].forEach(v => v.visible = visible);
        }
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.composer.setSize(window.innerWidth, window.innerHeight);
    }

    animate() {
        // Call animateHook on all registered modules
        for (const module of this.modules) {
            if (module.animateHook) {
                module.animateHook();
            }
        }

        const numVlogErrors = this.vlogErrors.length;
        if (numVlogErrors != this.lastNumVlogErrors) {
            console.log(`Number of vlog errors: ${numVlogErrors}`);
            this.lastNumVlogErrors = numVlogErrors;
        }

        this.controls.update();
        this.composer.render();
        this.stats.update();
    }
}

/**
 * Core "module" - contains all UIs other than debug things.
 * Owns model config and G-code logic.
 */
class ModuleMain {
    framework: ModuleFramework;
    
    // Model data
    models: any;
    model: string;
    targetSurf: any;
    
    // Stock configuration
    stockDiameter: number;
    stockLength: number;
    stockTopBuffer: number;
    baseZ: number;
    aboveWorkSize: number;
    showStockMesh: boolean;
    showTargetMesh: boolean;
    
    // Planning module
    modPlanner: ModulePlanner;

    constructor(framework: ModuleFramework, modPlanner: ModulePlanner) {
        this.framework = framework;
        this.modPlanner = modPlanner;

        // Setup data
        this.models = {
            GT2_PULLEY: "GT2_pulley",
            HELICAL_GEAR: "helical_gear",
            HELICAL_GEAR_STANDING: "helical_gear_standing",
            LATTICE: "cube_lattice",
            BENCHY: "benchy_25p",
            BOLT_M3: "M3x10",
        };

        this.model = this.models.GT2_PULLEY;
        this.stockDiameter = 15;
        this.stockLength = 20;
        this.stockTopBuffer = 0.5;
        this.showStockMesh = true;
        this.showTargetMesh = true;
        this.framework.updateVis("stock", [generateStockGeom(this.stockDiameter / 2, this.stockLength)], this.showStockMesh);

        // Register planner module with framework
        this.framework.registerModule(this.modPlanner);
        this.initGui();
    }

    #updateStockVis() {
        this.framework.updateVis("stock", [generateStockGeom(this.stockDiameter / 2, this.stockLength)], this.showStockMesh);
    }

    /**
     * Load STL model
     * @param fname Model filename
     */
    loadStl(fname: string) {
        const loader = new STLLoader();
        loader.load(
            `../assets/models/${fname}.stl`,
            (geometry) => {
                this.targetSurf = convGeomToSurf(geometry);
                const aabb = computeAABB(this.targetSurf);
                // assuming aabb.min.z == 0.
                this.aboveWorkSize = aabb.max.z + this.stockTopBuffer;
                this.baseZ = this.stockLength - this.aboveWorkSize;
                this.#updateStockVis();
                this.modPlanner.initPlan(this.targetSurf, this.baseZ, this.aboveWorkSize, this.stockDiameter);

                const material = new THREE.MeshPhysicalMaterial({
                    color: 0xb2ffc8,
                    metalness: 0.1,
                    roughness: 0.8,
                    transparent: true,
                    opacity: 0.8,
                });
                this.framework.updateVis("target", [new THREE.Mesh(geometry, material)]);
            },
            (progress) => {
                console.log('Loading progress: ', progress);
            },
            (error) => {
                console.error('Loading error: ', error);
            }
        );
    }

    copyGcode() {
        const gcode = this.generateGcode();
        navigator.clipboard.writeText(gcode);
        console.log("G-code copied to clipboard");
    }

    sendGcodeToSim() {
        const gcode = this.generateGcode();
        const bc = new BroadcastChannel("gcode");
        bc.postMessage(gcode);
        bc.close();
        console.log("G-code sent to sim");
    }

    generateGcode(): string {
        const planPath = this.modPlanner.planPath || [];

        let prevSweep = null;
        let prevType = null;
        let prevX = null;
        let prevY = null;
        let prevZ = null;
        let prevB = null;
        let prevC = null;

        const lines = [];

        lines.push(`; init`);
        lines.push(`G28`);
        lines.push(`M100`);
        lines.push(`M102`);

        for (let i = 0; i < planPath.length; i++) {
            const pt = planPath[i];
            if (prevSweep !== pt.sweep) {
                lines.push(`; sweep-${pt.sweep}`);
                prevSweep = pt.sweep;
            }

            let gcode = [];
            if (pt.type === "remove-work") {
                if (prevType !== pt.type) {
                    lines.push(`M3 WV100`);
                }
                gcode.push("G1");
            } else if (pt.type === "remove-tool") {
                if (prevType !== pt.type) {
                    lines.push(`M4 GV-100`);
                }
                gcode.push("G1");
            } else if (pt.type === "move-out" || pt.type === "move-in" || pt.type === "move") {
                if (prevType !== pt.type) {
                    lines.push(`M5`);
                }
                gcode.push("G0");
            } else {
                console.error("unknown path segment type", pt.type);
            }
            prevType = pt.type;

            const vals = pt.axisValues;
            if (prevX !== vals.x) {
                gcode.push(`X${vals.x.toFixed(3)}`);
                prevX = vals.x;
            }
            if (prevY !== vals.y) {
                gcode.push(`Y${vals.y.toFixed(3)}`);
                prevY = vals.y;
            }
            if (prevZ !== vals.z) {
                gcode.push(`Z${vals.z.toFixed(3)}`);
                prevZ = vals.z;
            }
            if (prevB !== vals.b) {
                gcode.push(`B${(vals.b * 180 / Math.PI).toFixed(3)}`);
                prevB = vals.b;
            }
            if (prevC !== vals.c) {
                gcode.push(`C${(vals.c * 180 / Math.PI).toFixed(3)}`);
                prevC = vals.c;
            }
            if (pt.toolRotDelta !== undefined) {
                gcode.push(`D${(pt.toolRotDelta * 180 / Math.PI).toFixed(2)}`);
            }
            if (pt.grindDelta !== undefined) {
                gcode.push(`GW${pt.grindDelta.toFixed(1)}`);
            }

            lines.push(gcode.join(" "));
        }

        lines.push(`; end`);
        lines.push(`M103`);

        lines.push("");
        return lines.join("\n");
    }

    initGui() {
        const gui = new GUI();
        gui.add(this, 'model', this.models).onChange((model) => {
            this.framework.updateVis("targ-vg", []);
            this.framework.updateVis("work-vg", []);
            this.framework.updateVis("misc", []);
            this.loadStl(model);
        });
        gui.add(this, "stockDiameter", 1, 30, 0.1).onChange(_ => {
            this.#updateStockVis();
            this.modPlanner.initPlan(this.targetSurf, this.baseZ, this.aboveWorkSize, this.stockDiameter);
        });
        gui.add(this, "stockLength", 1, 30, 0.1).onChange(_ => {
            this.baseZ = this.stockLength - this.aboveWorkSize;
            this.#updateStockVis();
            this.modPlanner.initPlan(this.targetSurf, this.baseZ, this.aboveWorkSize, this.stockDiameter);
        });
        gui.add(this, "showStockMesh").onChange(v => {
            this.framework.setVisVisibility("stock", v);
        }).listen();
        gui.add(this, "showTargetMesh").onChange(v => {
            this.framework.setVisVisibility("target", v);
        }).listen();

        gui.add(this.framework, "vlogDebugEnable").onChange(v => {
            debug.log = v;
        });
        gui.add(this.framework, "vlogDebugShow").onChange(v => {
            this.framework.updateVis("vlog-debug", this.framework.vlogDebugs, v);
        });
        gui.add(this.framework, "clearVlogDebug");
        this.modPlanner.guiHook(gui);

        gui.add(this, "copyGcode");
        gui.add(this, "sendGcodeToSim");

        this.loadStl(this.model);
    }
}


(async () => {
    await loadFont();
    const framework = new ModuleFramework();
    
    const modulePlanner = new ModulePlanner(framework);
    const moduleMain = new ModuleMain(framework, modulePlanner);
})();
