// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { N8AOPass } from './N8AO.js';
import { diceSurf } from './mesh.js';
import { createELHShape, createCylinderShape, createBoxShape, VoxelGridGpu, VoxelGridCpu, GpuKernels } from './voxel.js';

////////////////////////////////////////////////////////////////////////////////
// Basis

const fontLoader = new FontLoader();
let font = null;

const loadFont = async () => {
    return new Promise((resolve) => {
        fontLoader.load("./Source Sans 3_Regular.json", (f) => {
            font = f;
            resolve();
        });
    });
};

const debug = {
    vlog: (o) => { throw new Error("not initialized yet"); },
    vlogE: (o) => { throw new Error("not initialized yet"); },
    strict: false, // should raise exception at logic boundary even when it can continue.
    log: true, // emit vlogs (this is useful, because currently vlogs are somewhat slow)
};

// orange-teal-purple color palette for ABC axes.
const axisColorA = new THREE.Color(0xe67e22);
const axisColorB = new THREE.Color(0x1abc9c);
const axisColorC = new THREE.Color(0x9b59b6);

/**
 * @param {THREE.Vector3} p Start point
 * @param {THREE.Vector3} n Direction vector
 * @param {number} r Radius
 * @param {THREE.Color} col Color
 * @returns {THREE.Mesh} Cylinder visualization mesh
 */
const visCylinder = (p, n, r, col) => {
    // Cylinder lies along Y axis, centered at origin.
    const geom = new THREE.CylinderGeometry(r, r, 30, 8);
    const mat = new THREE.MeshBasicMaterial({ color: col, wireframe: true });
    const mesh = new THREE.Mesh(geom, mat);

    const rotV = new THREE.Vector3(0, 1, 0).cross(n);
    if (rotV.length() > 1e-6) {
        mesh.setRotationFromAxisAngle(rotV.clone().normalize(), Math.asin(rotV.length()));
    }
    mesh.position.copy(n.clone().multiplyScalar(15).add(p));
    return mesh;
};

/**
 * Quick visualization of a point.
 * 
 * @param {THREE.Vector3} p Location in work coords
 * @param {THREE.Color | string} col Color
 * @returns {THREE.Mesh} Sphere visualization mesh
 */
const visDot = (p, col) => {
    if (!debug.dotGeomCache) {
        debug.dotGeomCache = new THREE.SphereGeometry(0.1);
    }
    const sphMat = new THREE.MeshBasicMaterial({ color: col });
    const sph = new THREE.Mesh(debug.dotGeomCache, sphMat);
    sph.position.copy(p);
    return sph;
}

/**
 * Quick visualization of a quad. {p, p+a, p+b, p+a+b} as wireframe.
 * 
 * @param {THREE.Vector3} p Origin
 * @param {THREE.Vector3} a First edge vector
 * @param {THREE.Vector3} b Second edge vector
 * @param {THREE.Color} color Color
 * @returns {THREE.Mesh} Quad visualization mesh
 */
const visQuad = (p, a, b, color) => {
    const geom = new THREE.BufferGeometry();
    const pos = new Float32Array([
        p.x, p.y, p.z,
        p.x + a.x, p.y + a.y, p.z + a.z,
        p.x + a.x + b.x, p.y + a.y + b.y, p.z + a.z + b.z,
        p.x + b.x, p.y + b.y, p.z + b.z,
    ]);
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));

    return new THREE.LineLoop(geom, new THREE.LineBasicMaterial({ color }));
};

/**
 * @param {THREE.Vector3} p Location in work coords
 * @param {string} text Text to display
 * @param {number} [size=0.25] Text size
 * @param {string} [color="#222222"] Text color
 * @returns {THREE.Mesh} Text visualization mesh
 */
const visText = (p, text, size = 0.25, color = "#222222") => {
    const textGeom = new TextGeometry(text, {
        font,
        size,
        depth: 0.1,
    });
    const textMesh = new THREE.Mesh(textGeom, new THREE.MeshBasicMaterial({ color }));
    textMesh.position.copy(p);
    return textMesh;
};



////////////////////////////////////////////////////////////////////////////////
// Planner Module

const TG_FULL = 0; // fully occupied
const TG_PARTIAL = 1; // partially occupied
const TG_EMPTY = 2; // empty

const W_REMAINING = 0; // remaining work
const W_DONE = 1; // work done

const C_FULL_DONE = 0;  // current=full
const C_EMPTY_DONE = 1;  // current=empty
const C_EMPTY_REMAINING = 2; // current=non-empty
const C_PARTIAL_DONE = 3; // current=partial
const C_PARTIAL_REMAINING = 4; // current=full


/**
 * Represents current work & target as volume, and provides shape query and removal.
 * The class ensures that work is bigger than target.
 * 
 * Under the hood, it uses {@link VoxelGridGpu} to process various queries.
 */
class TrackingVoxelGrid {
    /**
     * @param {GpuKernels} kernels
     */
    constructor(kernels) {
        this.kernels = kernels;

        this.kernels.registerMapFn("set_protected_work_below_z", "u32", "u32", `
            vo = vi;
            if (p.z < thresh_z && vi == ${C_EMPTY_REMAINING}) {
                vo = ${C_FULL_DONE};
            }
        `, { thresh_z: "f32" });

        this.kernels.registerMap2Fn("work_deviation", "f32", "u32", "f32", `
            if (p.z < exclude_below_z) {
                vo = -1; // treat as empty
            } else if (vi2 == ${C_EMPTY_DONE}) {
                vo = -1; // empty
            } else if (vi1 == 0) {
                vo = 0; // inside
            } else {
                // trueD <= 0.5 vxDiag (partial vertex - partial center) + d (partial center - cell center) + 0.5 vxDiag (cell center - cell vertex)
                // because of triangle inequality.
                vo = vi1 + vx_diag;
            }
            `, { vx_diag: "f32", exclude_below_z: "f32" }
        );
        this.kernels.registerMapFn("extract_work", "u32", "u32", `
            if (p.z < exclude_below_z) {
                vo = 0;
            } else if (vi == ${C_EMPTY_DONE}) {
                vo = 0;
            } else {
                vo = 1;
            }
        `, { exclude_below_z: "f32" });
        this.kernels.registerMapFn("extract_region_by_id", "u32", "u32", `
            if (vi != reg_id) {
                vo = 0;
            } else {
                vo = 1;
            }
        `, { reg_id: "u32" });

        this.kernels.registerMapFn("not_tg_empty", "u32", "u32",
            `if (vi != ${C_EMPTY_DONE} && vi != ${C_EMPTY_REMAINING}) { vo = 1; } else { vo = 0; }`);

        this.kernels.registerMapFn("extract_target", "u32", "u32", `
            if (vi == ${C_FULL_DONE}) {
                vo = 255;
            } else if (vi == ${C_PARTIAL_DONE} || vi == ${C_PARTIAL_REMAINING}) {
                vo = 128;
            } else {
                vo = 0;
            }
        `);

        this.#registerCommitRemovalKernels();

        this.kernels.registerMapFn("work_remaining", "u32", "u32", `
            vo = 0;
            if (vi == ${C_EMPTY_REMAINING} || vi == ${C_PARTIAL_REMAINING}) {
                vo = 1;
            }
        `);

        this.kernels.registerMapFn("blocked", "u32", "u32", `
            if (vi == ${C_FULL_DONE} || vi == ${C_PARTIAL_DONE} || vi == ${C_PARTIAL_REMAINING}) {
                vo = 1;
            } else {
                vo = 0;
            }
        `);
        this.kernels.registerMapFn("has_work", "u32", "u32", `
            if (vi == ${C_EMPTY_REMAINING} || vi == ${C_PARTIAL_REMAINING}) {
                vo = 1;
            } else {
                vo = 0;
            }
        `);
    }

    #registerCommitRemovalKernels() {
        this.kernels.registerMap2Fn("check_reversal", "u32", "u32", "u32", `
            vo = 0;
            if (vi1 == 1 && vi2 == 0) {
                vo = 1;
            }
        `);
        this.kernels.registerMap2Fn("check_overcut", "u32", "u32", "u32", `
            vo = 0;
            if (vi2 > 0 && (vi1 == ${C_FULL_DONE} || vi1 == ${C_PARTIAL_DONE} || vi1 == ${C_PARTIAL_REMAINING})) {
                vo = 1;
            }
        `);
        this.kernels.registerMap2Fn("check_removed", "u32", "u32", "u32", `
            vo = 0;
            if (vi2 > 0 && (vi1 == ${C_EMPTY_REMAINING} || vi1 == ${C_PARTIAL_REMAINING})) {
                vo = 1;
            }
        `);
        this.kernels.registerMap2Fn("commit_min", "u32", "u32", "u32", `
            vo = vi1;
            if (vi2 > 0) {
                if (vi1 == ${C_EMPTY_REMAINING}) {
                    vo = ${C_EMPTY_DONE};
                } else if (vi1 == ${C_PARTIAL_REMAINING}) {
                    vo = ${C_PARTIAL_DONE};
                }
            }
        `);
    }

    /**
     * Configure work & target. Must be called before any other methods.
     * 
     * @param {VoxelGridCpu} work VoxelGrid (0: empty, 128: partial, 255: full)
     * @param {VoxelGridCpu} target VoxelGrid (0: empty, 128: partial, 255: full)
     * @returns {Promise<void>}
     * @async
     */
    async setFromWorkAndTarget(work, target) {
        this.res = work.res;
        this.numX = work.numX;
        this.numY = work.numY;
        this.numZ = work.numZ;
        this.ofs = work.ofs.clone();
        this.vx = new VoxelGridGpu(this.kernels, this.res, this.numX, this.numY, this.numZ, this.ofs, "u32");

        const vxCpu = new VoxelGridCpu(this.res, this.numX, this.numY, this.numZ, this.ofs);
        for (let iz = 0; iz < this.numZ; iz++) {
            for (let iy = 0; iy < this.numY; iy++) {
                for (let ix = 0; ix < this.numX; ix++) {
                    const ixFlat = ix + iy * this.numX + iz * this.numX * this.numY;
                    let tst = null;
                    switch (target.data[ixFlat]) {
                        case 0:
                            tst = TG_EMPTY;
                            break;
                        case 128:
                            tst = TG_PARTIAL;
                            break;
                        case 255:
                            tst = TG_FULL;
                            break;
                        default:
                            throw `Unknown target value: ${target.data[i]}`;
                    }
                    let wst = null;
                    switch (work.data[ixFlat]) {
                        case 0: // empty
                            if (tst !== TG_EMPTY) {
                                throw `Unachievable target: target=${tst}, work=empty`;
                            }
                            wst = W_DONE;
                            break;
                        case 128: // partial
                            if (tst !== TG_EMPTY) {
                                throw `(Possibly) unachievable target: target=${tst}, work=partial`;
                            }
                            wst = W_REMAINING;
                            break;
                        case 255: // full
                            wst = (tst === TG_FULL) ? W_DONE : W_REMAINING;
                            break;
                        default:
                            throw `Unknown work value: ${work.data[i]}`;
                    }
                    vxCpu.set(ix, iy, iz, TrackingVoxelGrid.combineTargetWork(tst, wst));
                }
            }
        }
        await this.kernels.copy(vxCpu, this.vx);
        this.#updateWorkDependentCache();
        this.distField = this.#computeDistField();
    }

    /**
     * Designate work below specified z to be protected. Primarily used to mark stock that should be kept for next session.
     * @param {number} z Z+ in work coords.
     * @returns {Promise<void>}
     * @async
     */
    async setProtectedWorkBelowZ(z) {
        this.protectedWorkBelowZ = z;
        const tempVg = this.kernels.createLike(this.vx);
        await this.kernels.copy(this.vx, tempVg);
        this.kernels.map("set_protected_work_below_z", tempVg, this.vx, { "thresh_z": z });
        this.kernels.destroy(tempVg);
        this.#updateWorkDependentCache();
    }

    /**
     * Extract work volume as voxels. Each cell will contain deviation from target shape.
     * positive value indicates deviation. 0 for perfect finish or inside. -1 for empty regions.
     * @param {boolean} [excludeProtectedWork=false] If true, exclude protected work.
     * @returns {VoxelGridGpu} (f32)
     */
    extractWorkWithDeviation(excludeProtectedWork = false) {
        let zThresh = excludeProtectedWork ? this.protectedWorkBelowZ + this.res : -1e3; // +this.res ensures removal of cells just at the Z boundary.
        const res = this.kernels.createLike(this.vx, "f32");
        this.kernels.map2("work_deviation", this.distField, this.vx, res, { "vx_diag": this.res * Math.sqrt(3), "exclude_below_z": zThresh });
        return res;
    }

    /**
     * Extract work volume as voxels. Each cell will contain 1 if it has work, 0 otherwise.
     * @param {boolean} excludeProtectedWork 
     * @returns {VoxelGridGpu} (u32) 1 exists
     */
    extractWorkFlag(excludeProtectedWork = false) {
        let zThresh = excludeProtectedWork ? this.protectedWorkBelowZ + this.res : -1e3; // +this.res ensures removal of cells just at the Z boundary.
        const res = this.kernels.createLike(this.vx, "u32");
        this.kernels.map("extract_work", this.vx, res, { "exclude_below_z": zThresh });
        return res;
    }

    /** Compute distance field (from target). This data is work-independent.*/
    #computeDistField() {
        const initial = this.kernels.createLike(this.vx, "u32");
        const dist = this.kernels.createLike(this.vx, "f32");
        this.kernels.map("not_tg_empty", this.vx, initial);
        this.kernels.distField(initial, dist);
        this.kernels.destroy(initial);
        return dist;
    }

    /**
     * Scaffold for refactoring.
     * @returns {Promise<VoxelGridCpu>} (0: empty, 128: partial, 255: full)
     * @async
     */
    async extractTarget() {
        const temp = this.kernels.createLike(this.vx, "u32");
        this.kernels.map("extract_target", this.vx, temp);

        const res = new VoxelGridCpu(this.res, this.numX, this.numY, this.numZ, this.ofs);
        await this.kernels.copy(temp, res);
        this.kernels.destroy(temp);

        return res;
    }

    /**
     * Commit (rough) removal of minGeom and maxGeom.
     * maxGeom >= minGeom must hold. otherwise, throw error.
     * 
     * Rough removal means, this cut can process TG_EMPTY cells, but not TG_PARTIAL cells.
     * When cut can potentially affect TG_PARTIAL cells, it will be error (as rough cut might ruin the voxel irreversibly).
     * 
     * @param {Array} minShapes array of shapes, treated as union of all shapes
     * @param {Array} maxShapes array of shapes, treated as union of all shapes
     * @param {boolean} [ignoreOvercutErrors=false] if true, ignore overcut errors. Hack to get final cut done.
     * @returns {Promise<number>} volume of neewly removed work.
     * @async
     */
    async commitRemoval(minShapes, maxShapes, ignoreOvercutErrors = false) {
        console.log("Commit removal", minShapes, maxShapes);
        const minVg = this.kernels.createLike(this.vx, "u32");
        const maxVg = this.kernels.createLike(this.vx, "u32");
        for (const shape of minShapes) {
            await this.kernels.fillShape(shape, minVg, "in");
        }
        for (const shape of maxShapes) {
            await this.kernels.fillShape(shape, maxVg, "out");
        }

        // Check no-reversal of min/max. As this is relatively rare & easy to spot error, we don't log them.
        const reversalVg = this.kernels.createLike(this.vx, "u32");
        this.kernels.map2("check_reversal", minVg, maxVg, reversalVg);
        const numReversals = await this.kernels.reduce("sum", reversalVg);
        this.kernels.destroy(reversalVg);
        if (numReversals > 0) {
            throw `min/max reversal at ${numReversals} locations`;
        }

        // Check no-overcut. This error is pretty dynamic, so visual log is necessary.
        if (!ignoreOvercutErrors) {
            const overcutVg = this.kernels.createLike(this.vx, "u32");
            this.kernels.map2("check_overcut", this.vx, maxVg, overcutVg);
            const numDamages = await this.kernels.reduce("sum", overcutVg);
            if (numDamages > 0) {
                const overcutVgCpu = this.kernels.createLikeCpu(overcutVg);
                await this.kernels.copy(overcutVg, overcutVgCpu);
                for (let z = 0; z < this.numZ; z++) {
                    for (let y = 0; y < this.numY; y++) {
                        for (let x = 0; x < this.numX; x++) {
                            if (overcutVgCpu.get(x, y, z) == 0) {
                                continue;
                            }
                            debug.vlogE(visDot(this.#centerOf(x, y, z), "violet"));
                        }
                    }
                }
            }
            this.kernels.destroy(overcutVg);
            if (debug.strict) {
                if (numDamages > 0) {
                    throw `${numDamages} cells are potentially damaged`;
                }
            }
        }

        // Finally ready to commit min cuts.
        const removedVg = this.kernels.createLike(this.vx, "u32");
        this.kernels.map2("check_removed", this.vx, minVg, removedVg);
        const resultVg = this.kernels.createLike(this.vx, "u32");
        this.kernels.map2("commit_min", this.vx, minVg, resultVg);
        await this.kernels.copy(resultVg, this.vx);
        this.kernels.destroy(resultVg);
        const numRemoved = await this.kernels.reduce("sum", removedVg);
        this.kernels.destroy(removedVg);

        // Remove disconnected fluffs.
        const workFlag = this.extractWorkFlag(true);
        const connRegs = this.kernels.createLike(this.vx, "u32");
        this.kernels.connectedRegions(workFlag, connRegs);
        const connRegStats = await this.kernels.top4Labels(connRegs);
        
        if (connRegStats.size > 1) {
            // something was disconnected.
            const regVg = this.kernels.createLike(this.vx, "u32");
            const resultVg = this.kernels.createLike(this.vx, "u32");

            const maxRegSize = Math.max(...connRegStats.values());
            for (const [regId, size] of connRegStats.entries()) {
                if (size === maxRegSize) {
                    continue;
                }
                if (size > maxRegSize * 0.5) {
                    // big part fell off; something is terribly wrong.
                    throw `Big region (ID=${regId}, size=${size}) fell off: ${JSON.stringify(connRegStats)}`;
                }
                // remove small things.
                // TODO: need to check gravity direction and shape of the region, to decide it can safely fall off.
                this.kernels.map("extract_region_by_id", connRegs, regVg, { reg_id: regId });

                this.kernels.map2("commit_min", this.vx, regVg, resultVg);
                await this.kernels.copy(resultVg, this.vx);
                console.log(`Small fragment of volume ${(size * this.res ** 3).toFixed(9)} mm^3 fell off.`);
            }
            this.kernels.destroy(regVg);
            this.kernels.destroy(resultVg);

            // TODO: maybe shoudl re-check overcut?
        }
        this.kernels.destroy(connRegs);
        this.kernels.destroy(workFlag);

        this.#updateWorkDependentCache();

        return numRemoved * this.res ** 3;
    }

    #updateWorkDependentCache() {
        if (!this.cacheHasWork) {
            this.cacheHasWork = this.kernels.createLike(this.vx, "u32");
        }
        if (!this.cacheBlocked) {
            this.cacheBlocked = this.kernels.createLike(this.vx, "u32");
        }
        this.kernels.map("work_remaining", this.vx, this.cacheHasWork);
        this.kernels.map("blocked", this.vx, this.cacheBlocked);
    }

    /**
     * Returns volume of remaining work.
     * @returns {Promise<number>} volume of remaining work.
     * @async
     */
    async getRemainingWorkVol() {
        const flagVg = this.kernels.createLike(this.vx, "u32");
        this.kernels.map("work_remaining", this.vx, flagVg);
        const cnt = await this.kernels.reduce("sum", flagVg);
        this.kernels.destroy(flagVg);
        return cnt * this.res ** 3;
    }

    /**
     * Returns range of the work in normal direction conservatively.
     * Conservative means: "no-work" region never has work, despite presence of quantization error.
     * 
     * @param {THREE.Vector3} dir Unit direction vector, in work coords.
     * @returns {Promise<{min: number, max: number}>} Offsets. No work exists outside the range.
     * @async
     */
    async queryWorkRange(dir) {
        const work = this.kernels.createLike(this.vx, "u32");
        this.kernels.map("work_remaining", this.vx, work);
        const result = await this.kernels.boundOfAxis(dir, work, "out");
        this.kernels.destroy(work);
        return result;
    }

    /**
     * Returns true if given shape contains cut-forbidden parts.
     * Conservative: voxels with potential overlaps will be considered for block-detection.
     * @param {Object} shape Shape object, created by {@link createCylinderShape}, {@link createELHShape}, etc.
     * @returns {Promise<boolean>} true if blocked, false otherwise
     * @async
     */
    async queryBlocked(shape) {
        return await this.kernels.countInShape(shape, this.cacheBlocked, "out") > 0;
    }

    /**
     * Returns true if given shape contains work to do. Does not guarantee it's workable (not blocked).
     * 
     * @param {Object} shape Shape object, created by {@link createCylinderShape}, {@link createELHShape}, etc.
     * @returns {Promise<boolean>} true if has work, false otherwise
     * @async
     */
    async queryHasWork(shape) {
        return await this.kernels.countInShape(shape, this.cacheHasWork, "nearest") > 0;
    }

    /**
     * Much faster way to get result for multiple {@link queryBlocked} or {@link queryHasWork} calls.
     * 
     * @param {Array<{shape: Object, query: "blocked" | "has_work"}>} queries 
     * @returns {Promise<Array<boolean>>} results
     * @async
     */
    async parallelQuery(queries) {
        const resultBuf = this.kernels.createBuffer(4 * queries.length);
        for (let i = 0; i < queries.length; i++) {
            const { shape, query } = queries[i];
            const offset = i * 4;
            if (query === "blocked") {
                this.kernels.countInShapeRaw(shape, this.cacheBlocked, "out", resultBuf, offset);
            } else if (query === "has_work") {
                this.kernels.countInShapeRaw(shape, this.cacheHasWork, "nearest", resultBuf, offset);
            } else {
                throw `Invalid query type: ${query}`;
            }
        }
        const readBuf = this.kernels.createBufferForCpuRead(4 * queries.length);
        await this.kernels.copyBuffer(resultBuf, readBuf);
        resultBuf.destroy();
        await readBuf.mapAsync(GPUMapMode.READ);
        const results = new Uint32Array(readBuf.getMappedRange()).map(v => v > 0);
        readBuf.destroy();
        return results;
    }

    static combineTargetWork(t, w) {
        switch (t) {
            case TG_FULL:
                return C_FULL_DONE;
            case TG_EMPTY:
                return w === W_DONE ? C_EMPTY_DONE : C_EMPTY_REMAINING;
            case TG_PARTIAL:
                return w === W_DONE ? C_PARTIAL_DONE : C_PARTIAL_REMAINING;
        }
        throw `Invalid cell state T=${t}, W=${w}`;
    }

    /**
     * Get center coordinates of cell at given indices
     * @param {number} ix X coordinate
     * @param {number} iy Y coordinate
     * @param {number} iz Z coordinate
     * @returns {THREE.Vector3} Center point of cell
     */
    #centerOf(ix, iy, iz) {
        return new THREE.Vector3(ix, iy, iz).addScalar(0.5).multiplyScalar(this.res).add(this.ofs);
    }
}

/**
 * Computes AABB for bunch of points
 * @param {Float32Array} pts Points array [x0, y0, z0, x1, y1, z1, ...]
 * @returns {{min: THREE.Vector3, max: THREE.Vector3}} AABB bounds
 */
const computeAABB = (pts) => {
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < pts.length; i += 3) {
        const v = new THREE.Vector3(pts[i + 0], pts[i + 1], pts[i + 2]);
        min.min(v);
        max.max(v);
    }
    return { min, max };
};

/**
 * Initialize voxel grid for storing points
 * @param {Float32Array} pts Points array [x0, y0, z0, x1, y1, z1, ...]
 * @param {number} resMm Voxel resolution
 * @returns {VoxelGridCpu} Initialized voxel grid
 */
const initVGForPoints = (pts, resMm) => {
    const MARGIN_MM = resMm; // want to keep boundary one voxel clear to avoid any mishaps. resMm should be enough.
    const { min, max } = computeAABB(pts);
    const center = min.clone().add(max).divideScalar(2);

    min.subScalar(MARGIN_MM);
    max.addScalar(MARGIN_MM);

    const numV = max.clone().sub(min).divideScalar(resMm).ceil();
    const gridMin = center.clone().sub(numV.clone().multiplyScalar(resMm / 2));
    return new VoxelGridCpu(resMm, numV.x, numV.y, numV.z, gridMin);
};

/**
 * Apply translation to geometry in-place
 * @param {THREE.BufferGeometry} geom Geometry to translate
 * @param {THREE.Vector3} trans Translation vector
 */
const translateGeom = (geom, trans) => {
    const pos = geom.getAttribute("position").array;
    for (let i = 0; i < pos.length; i += 3) {
        pos[i + 0] += trans.x;
        pos[i + 1] += trans.y;
        pos[i + 2] += trans.z;
    }
};


/**
 * Get "triangle soup" representation from a geometry
 * @param {THREE.BufferGeometry} geom Input geometry
 * @returns {Float32Array} Triangle soup array
 */
const convGeomToSurf = (geom) => {
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
 * @param {number} [stockRadius=7.5] Radius of the stock
 * @param {number} [stockHeight=15] Height of the stock
 * @returns {THREE.BufferGeometry} Stock cylinder geometry
 */
const generateStockGeom = (stockRadius = 7.5, stockHeight = 15) => {
    const geom = new THREE.CylinderGeometry(stockRadius, stockRadius, stockHeight, 64, 1);
    const transf = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 0, stockHeight / 2),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
        new THREE.Vector3(1, 1, 1));
    geom.applyMatrix4(transf);
    return geom;
};


/**
 * Create visualization for voxel grid
 * @param {VoxelGridCpu} vg Voxel grid to visualize
 * @param {string} [label=""] Optional label to display on the voxel grid
 * @param {string} [mode="occupancy"] "occupancy" | "deviation". "occupancy" treats 255:full, 128:partial, 0:empty. "deviation" is >=0 as deviation and -1 as empty
 * @param {number} [maxDev=3] Maximum deviation to visualize. Only used in "deviation" mode.
 * @returns {THREE.Object3D} Visualization object
 */
const createVgVis = (vg, label = "", mode = "occupancy", maxDev = 3) => {
    const t0 = performance.now();
    const cubeSize = vg.res * 1.0;
    const cubeGeom = new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize);

    const meshContainer = new THREE.Object3D();
    meshContainer.position.copy(vg.ofs);
    const axesHelper = new THREE.AxesHelper();
    axesHelper.scale.set(vg.res * vg.numX, vg.res * vg.numY, vg.res * vg.numZ);

    if (mode === "occupancy") {
        if (vg.type !== "u32") {
            throw `Invalid vg type for occupancy: ${vg.type}`;
        }

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
    } else if (mode === "deviation") {
        if (vg.type !== "f32") {
            throw `Invalid vg type for deviation: ${vg.type}`;
        }

        const neighborOffsets = [
            [1, 0, 0],
            [-1, 0, 0],
            [0, 1, 0],
            [0, -1, 0],
            [0, 0, 1],
            [0, 0, -1],
        ];
        const isVisible = (ix, iy, iz) => {
            const v = vg.get(ix, iy, iz);
            if (v < 0) {
                return false;
            }
            let numFilledNeighbors = 0;
            for (let [dx, dy, dz] of neighborOffsets) {
                const nx = ix + dx;
                const ny = iy + dy;
                const nz = iz + dz;
                if (nx < 0 || nx >= vg.numX || ny < 0 || ny >= vg.numY || nz < 0 || nz >= vg.numZ) {
                    continue;
                }
                const nv = vg.get(nx, ny, nz);
                if (nv >= 0) {
                    numFilledNeighbors++;
                }
            }
            return numFilledNeighbors < neighborOffsets.length; // if any neighbor is not filled, this cell is visible.
        };

        // Pass 1: count visible voxels
        let numVisibleVoxels = 0;
        for (let iz = 0; iz < vg.numZ; iz++) {
            for (let iy = 0; iy < vg.numY; iy++) {
                for (let ix = 0; ix < vg.numX; ix++) {
                    if (isVisible(ix, iy, iz)) {
                        numVisibleVoxels++;
                    }
                }
            }
        }

        // Pass 2: copy visible voxel data into buffer.
        const mesh = new THREE.InstancedMesh(cubeGeom, new THREE.MeshLambertMaterial(), numVisibleVoxels);
        let instanceIx = 0;
        for (let iz = 0; iz < vg.numZ; iz++) {
            for (let iy = 0; iy < vg.numY; iy++) {
                for (let ix = 0; ix < vg.numX; ix++) {
                    if (!isVisible(ix, iy, iz)) {
                        continue;
                    }

                    const v = vg.get(ix, iy, iz);

                    // apply deviation color, from blue(0) to red(maxDev).
                    const t = Math.min(1, v / maxDev);
                    mesh.setColorAt(instanceIx, new THREE.Color(0.2 + t * 0.8, 0.2, 0.2 + (1 - t) * 0.8));

                    const mtx = new THREE.Matrix4();
                    mtx.compose(
                        new THREE.Vector3(ix, iy, iz).addScalar(0.5).multiplyScalar(vg.res),
                        new THREE.Quaternion(),
                        new THREE.Vector3(1, 1, 1));
                    mesh.setMatrixAt(instanceIx, mtx);
                    instanceIx++;
                }
            }
        }

        meshContainer.add(mesh);
        mesh.add(axesHelper);
    } else {
        throw `Invalid mode: ${mode}`;
    }

    if (label !== "") {
        const textGeom = new TextGeometry(label, {
            font,
            size: 2,
            depth: 0.1,
        });
        const textMesh = new THREE.Mesh(textGeom, new THREE.MeshBasicMaterial({ color: "#222222" }));
        meshContainer.add(textMesh);
    }

    console.log(`createVgVis took ${performance.now() - t0}ms`);
    return meshContainer;
};

/**
 * Visualize "max deviation" in voxel grid.
 * @param {VoxelGridCpu} vg - Voxel grid to visualize
 * @param {number} - Maximum deviation to visualize
 * @returns {THREE.Object3D} Visualization object
 */
const createMaxDeviationVis = (vg, maxDev) => {
    const MAX_NUM_VIS = 100;
    const vis = new THREE.Object3D();
    let numAdded = 0;
    for (let iz = 0; iz < vg.numZ; iz++) {
        for (let iy = 0; iy < vg.numY; iy++) {
            for (let ix = 0; ix < vg.numX; ix++) {
                const v = vg.get(ix, iy, iz);
                if (v < 0) {
                    continue;
                }
                if (v >= maxDev) {
                    vis.add(visDot(vg.centerOf(ix, iy, iz), "red"));
                    numAdded++;
                    if (numAdded >= MAX_NUM_VIS) {
                        break;
                    }
                }
            }
        }
    }
    return vis;
};

/**
 * Visualize tool tip path in machine coordinates.
 *
 * @param {Array<THREE.Vector3>} path - Array of path segments
 * @param {number} [highlightSweep] - If specified, highlight this sweep.
 * @returns {THREE.Object3D} Path visualization object
 */
const createPathVis = (path, highlightSweep = -1) => {
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
 * @param {THREE.Vector3} z Z-basis vector
 * @returns {THREE.Matrix4} Rotation matrix
 */
const createRotationWithZ = (z) => {
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
 * @param {THREE.Vector3} p - Point to offset (readonly)
 * @param {Array<[THREE.Vector3, number]>} offsets - List of vector & coefficient pairs
 * @returns {THREE.Vector3} Offset point (new instance)
 */
const offsetPoint = (p, ...offsets) => {
    const ret = p.clone();
    const temp = new THREE.Vector3();
    for (const [v, k] of offsets) {
        ret.add(temp.copy(v).multiplyScalar(k));
    }
    return ret;
};


/**
 * Utility to create box shape from base point and axis specs.
 * @param {THREE.Vector3} base - Base point
 * @param {Array<[string, THREE.Vector3, number]>} axisSpecs - List of anchor ("center", "origin") & base vector & k. base vector * k must span full-size of the box.
 * @returns {Object} Box shape
 */
const createBoxShapeFrom = (base, ...axisSpecs) => {
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
    return createBoxShape(center, ...halfVecs);
};


/**
 * Generate stock visualization.
 * @param {number} [stockRadius=7.5] - Radius of the stock
 * @param {number} [stockHeight=15] - Height of the stock
 * @param {number} [baseZ=0] - Z+ in machine coords where work coords Z=0 (bottom of the targer surface).
 * @returns {THREE.Object3D} Stock visualization object
 */
const generateStock = (stockRadius = 7.5, stockHeight = 15, baseZ = 0) => {
    const stock = new THREE.Mesh(
        generateStockGeom(stockRadius, stockHeight),
        new THREE.MeshLambertMaterial({ color: "blue", wireframe: true, transparent: true, opacity: 0.05 }));
    stock.position.z = -baseZ;
    return stock;
};

/**
 * Generate tool geom, origin = tool tip. In Z+ direction, there will be tool base marker.
 * @returns {THREE.Object3D} Tool visualization object
 */
const generateTool = (toolLength, toolDiameter) => {
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
     * @param {THREE.Vector3} tipPos - Tip position in work or machine coordinates (determined by isPosW)
     * @param {THREE.Vector3} tipNormalW - Tip normal in work coordinates. Tip normal corresponds to work surface, and points towards tool holder
     * @param {number} toolLength - Tool length
     * @param {boolean} isPosW - True if tipPos is in work coordinates, false if in machine coordinates
     * @returns {{vals: {x: number, y: number, z: number, b: number, c: number}, tipPosM: THREE.Vector3, tipPosW: THREE.Vector3}}
     *   - vals: Machine instructions for moving work table & tool base
     *   - tipPosM: Tip position in machine coordinates
     *   - tipPosW: Tip position in work coordinates
     */
    solveIk(tipPos, tipNormalW, toolLength, isPosW) {
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
    /**
     * @param {number} sweepIx - Sweep index
     * @param {string} group - Group name
     * @param {THREE.Vector3} normal - Normal vector
     * @param {number} minToolLength - Minimum tool length required. Can change later with 
     * @param {number} toolIx - Tool index
     * @param {number} toolLength - Current tool length
     * @param {Object} machineConfig - Target machine's physical configuration
     */
    constructor(sweepIx, group, normal, minToolLength, toolIx, toolLength, machineConfig) {
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
     * @param {number} newMinToolLength - New minimum tool length
     */
    updateMinToolLength(newMinToolLength) {
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
     * @param {number} discardLength - Length of the tool to discard
     */
    discardToolTip(discardLength) {
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
     * @param {string} type - label for this move
     * @param {THREE.Vector3} tipPos - Tip position in work coordinates
     */
    nonRemove(type, tipPos) {
        this.path.push(this.#withAxisValue(type, { tipPosW: tipPos }));
        this.prevPtTipPos = tipPos;
    }

    /**
     * Add min-shape without changing path.
     * This can be used when caller knows min-cut happens due to combination of multiple remove() calls,
     * but min-cut cannot be easily attributed to individual remove() calls separately.
     * @param {Object} shape - Shape to add
     */
    addMinRemoveShape(shape) {
        this.minSweepRemoveShapes.push(shape);
    }

    /**
     * Add material-removing move. (i.e. G1 move) The move must be horizontal.
     * @param {THREE.Vector3} tipPos - Tip position in work coordinates
     * @param {number} toolRotDelta - Tool rotation delta in radians
     * @param {number} maxDiameter - Maximum diameter of the tool
     * @param {number} minDiameter - Minimum diameter of the tool
     */
    removeHorizontal(tipPos, toolRotDelta, maxDiameter, minDiameter) {
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
     * @param {THREE.Vector3} tipPos - Tip position in work coordinates
     * @param {number} toolRotDelta - Tool rotation delta in radians
     * @param {number} diameter - Diameter of the tool
     * @param {number} uncutDepth - Depth that might not be cut (reduce min cut by this)
     */
    removeVertical(tipPos, toolRotDelta, diameter, uncutDepth) {
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
class Planner {
    /**
     * @param {Function} updateVis - Function to update visualizations
     * @param {Function} setVisVisibility - Function to set visualization visibility
     */
    constructor(updateVis, setVisVisibility) {
        this.updateVis = updateVis;
        this.setVisVisibility = setVisVisibility;

        this.machineConfig = sparkWg1Config; // in future, there will be multiple options.

        // tool vis
        this.updateVisTransforms(new THREE.Vector3(-15, -15, 5), new THREE.Vector3(0, 0, 1), this.toolNaturalLength);

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
        this.toolLength = this.toolNaturalLength;
        this.showPlanPath = true;
        this.highlightSweep = 2;

        if (!navigator.gpu) {
            throw new Error('WebGPU not supported');
        }
        (async () => {
            const adapter = await navigator.gpu.requestAdapter();
            this.kernels = new GpuKernels(await adapter.requestDevice());
        })();
    }

    /**
     * @param {lilgui} gui - lilgui instance
     */
    guiHook(gui) {
        gui.add(this, "resMm", [0.01, 0.05, 0.1, 0.2, 0.5]);

        gui.add(this, "genAllSweeps");
        gui.add(this, "genNextSweep");
        gui.add(this, "numSweeps").disable().onChange(_ => {
            highlightGui.max(this.numSweeps);
        }).listen();
        gui.add(this, "removedVol").name("Removed Vol (㎣)").decimals(9).disable().listen();
        gui.add(this, "remainingVol").name("Remaining Vol (㎣)").decimals(9).disable().listen();
        gui.add(this, "deviation").name("Deviation (mm)").decimals(3).disable().listen();
        gui.add(this, "toolIx").disable().listen();
        gui.add(this, "showTarget")
            .onChange(_ => this.setVisVisibility("targ-vg", this.showTarget))
            .listen();
        gui.add(this, "showWork")
            .onChange(_ => this.setVisVisibility("work-vg", this.showWork))
            .listen();
        gui.add(this, "showPlanPath")
            .onChange(_ => this.setVisVisibility("plan-path-vg", this.showPlanPath))
            .listen();
        this.highlightGui = gui.add(this, "highlightSweep", 0, 50, 1).onChange(_ => {
            if (!this.planPath) {
                return;
            }
            this.updateVis("plan-path-vg", [createPathVis(this.planPath, this.highlightSweep)], this.showPlanPath);
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

    /**
     * Setup new targets.
     *
     * @param {THREE.BufferGeometry} targetSurf - Target surface geometry
     * @param {number} baseZ - Z+ in machine coords where work coords Z=0 (bottom of the targer surface).
     * @param {number} aboveWorkSize - Length of stock to be worked "above" baseZ plane. Note below-baseZ work will be still removed to cut off the work.
     * @param {number} stockDiameter - Diameter of the stock.
     */
    initPlan(targetSurf, baseZ, aboveWorkSize, stockDiameter) {
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
     * @returns {"done" | "break" | "continue"} "done": gen is done. "break": gen requests breakpoint for debug, restart needs manual intervention. "continue": gen should be continued.
     */
    async genNextSweep() {
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
     * Generates all sweeps.
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
        const workDevGpu = this.trvg.extractWorkWithDeviation();
        const workDevCpu = this.kernels.createLikeCpu(workDevGpu);
        await this.kernels.copy(workDevGpu, workDevCpu);
        this.updateVis("work-vg", [createVgVis(workDevCpu, "work", "deviation")], this.showWork);
        this.updateVis("targ-vg", [createVgVis(await this.trvg.extractTarget())], this.showTarget);
        this.updateVis("plan-path-vg", [createPathVis(this.planPath)], this.showPlanPath);

        ////////////////////////////////////////
        // Sweep generators
        // Plan consists of sweeps. Sweep is a composable set of operation that contains actual movements (path).
        // No movements exists outside of sweeps.
        //
        // For sweep to have nice composability, we have following pre/post-condition for every sweep:
        // * Tool is not touching work nor grinder
        // * De-energized
        // * Tool shape is prestine (have original tool diameter). Tool length can differ from original.

        // Global sweep hyperparams
        const feedDepth = 1; // TODO: reduce later. current values allow fast debug, but too big for actual use.

        /**
         * Generate "planar sweep", directly below given plane.
         * Planer sweep only uses horizontal cuts.
         * 
         * @param {THREE.Vector3} normal Normal vector, in work coords. = tip normal
         * @param {number} offset Offset from the plane. offset * normal forms the plane.
         * @param {number} toolDiameter Tool diameter to use for this sweep.
         * @returns {Promise<{partialPath: PartialPath, ignoreOvercutErrors: boolean} | null>} null if impossible
         * @async
         */
        const genPlanarSweep = async (normal, offset, toolDiameter) => {
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
            for (let ixRow = 0; ixRow < numRows; ixRow++) {
                const row = new Array(numSegs);
                rows[ixRow] = row;
            }
            const queries = [];
            for (let ixRow = 0; ixRow < numRows; ixRow++) {
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
                        if (state === "blocked") {
                            if (hasWork) {
                                debug.vlog(visDot(segCenterBot(ixRow, ixSeg), "orange"));
                            } else {
                                debug.vlog(visDot(segCenterBot(ixRow, ixSeg), "red"));
                            }
                        } else if (state === "work") {
                            debug.vlog(visDot(segCenterBot(ixRow, ixSeg), "green"));
                        } else {
                            debug.vlog(visDot(segCenterBot(ixRow, ixSeg), "gray"));
                        }
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
            };
        };

        /**
         * Generate "drill sweep", axis=normal. Single drill sweep is single hole.
         * 
         * @param {THREE.Vector3} normal Normal vector, in work coords. = tip normal
         * @param {number} toolDiameter Tool diameter to use for this sweep.
         * @returns {Promise<{partialPath: PartialPath, ignoreOvercutErrors: boolean} | null>} null if impossible
         * @async
         */
        const genDrillSweep = async (normal, toolDiameter) => {
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
            const queries = [];
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
            };
        };

        /**
         * Generate "part off" sweep.
         * @returns {Promise<{partialPath: PartialPath, ignoreOvercutErrors: boolean}>}
         * @async
         */
        const genPartOffSweep = async () => {
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
        };

        ////////////////////////////////////////
        // Main Loop

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
         * @param {{partialPath: PartialPath, ignoreOvercutErrors: boolean}} sweep - Sweep to commit
         * @returns {Promise<boolean>} true if committed, false if rejected.
         * @async
         */
        const tryCommitSweep = async (sweep) => {
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
                    const workDeviation = await this.trvg.extractWorkWithDeviation(true);
                    const workDevCpu = this.kernels.createLikeCpu(workDeviation);
                    await this.kernels.copy(workDeviation, workDevCpu);
                    this.updateVis("plan-path-vg", [createPathVis(this.planPath, this.highlightSweep)], this.showPlanPath, false);
                    this.deviation = workDevCpu.max();
                    this.updateVis("work-vg", [createVgVis(workDevCpu, "work-vg", "deviation", this.deviation)], this.showWork);
                    const lastPt = this.planPath[this.planPath.length - 1];
                    this.updateVisTransforms(lastPt.tipPosW, lastPt.tipNormalW, this.toolLength);
                    this.updateVis("work-max-dev", [createMaxDeviationVis(workDevCpu, this.deviation)]);
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
                const sweep = await genPlanarSweep(normal, offset, this.machineConfig.toolNaturalDiameter);
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

        // yield "break";

        // rough drills
        for (const normal of candidateNormals) {
            const sweep = await genDrillSweep(normal, this.machineConfig.toolNaturalDiameter / 2);
            if (sweep) {
                if (await tryCommitSweep(sweep)) {
                    yield;
                }
            }
        }

        // part off
        const sweep = await genPartOffSweep();
        if (await tryCommitSweep(sweep)) {
            yield;
        }

        // not done, but out of choices
        const dt = performance.now() - t0;
        console.log(`possible sweep exhausted after ${dt / 1e3}sec (${dt / this.numSweeps}ms/sweep)`);
    }


    updateVisTransforms(tipPos, tipNormal, toolLength) {
        const tool = generateTool(toolLength, this.machineConfig.toolNaturalDiameter);
        this.updateVis("tool", [tool], false);

        tool.position.copy(tipPos);
        tool.setRotationFromMatrix(createRotationWithZ(tipNormal));
    }
}



////////////////////////////////////////////////////////////////////////////////
// 3D view (Module + basis)



/**
 * Provides basic UI framework, 3D scene, and mesh/gcode I/O UI.
 * Scene is in mm unit. Right-handed, X+ up. Work-coordinates.
 */
class View3D {
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
        this.updateVis("stock", [generateStock(this.stockDiameter / 2, this.stockLength)], this.showStockMesh);

        this.vlogDebugEnable = true;
        this.vlogDebugShow = false;

        this.renderAoRadius = 5;
        this.renderDistFallOff = 1.0;
        this.renderAoItensity = 5;
        this.renderAoScreenRadius = false;

        // Setup modules & GUI
        this.modPlanner = new Planner((group, vs, visible = true) => this.updateVis(group, vs, visible), (group, visible = true) => this.setVisVisibility(group, visible));
        this.initGui();
    }

    clearVlogDebug() {
        this.vlogDebugs = [];
        this.updateVis("vlog-debug", this.vlogDebugs, this.showVlogDebug);
    }

    initGui() {
        const gui = new GUI();
        gui.add(this, 'model', this.models).onChange((model) => {
            this.updateVis("targ-vg", []);
            this.updateVis("work-vg", []);
            this.updateVis("misc", []);
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
            this.setVisVisibility("stock", v);
        }).listen();
        gui.add(this, "showTargetMesh").onChange(v => {
            this.setVisVisibility("target", v);
        }).listen();

        gui.add(this, "vlogDebugEnable").onChange(v => {
            debug.log = v;
        });
        gui.add(this, "vlogDebugShow").onChange(v => {
            this.updateVis("vlog-debug", this.vlogDebugs, v);
        });
        gui.add(this, "clearVlogDebug");
        this.modPlanner.guiHook(gui);

        gui.add(this, "copyGcode");
        gui.add(this, "sendGcodeToSim");

        this.loadStl(this.model);
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
        container.appendChild(this.stats.dom);

        const guiStatsEl = document.createElement('div');
        guiStatsEl.classList.add('gui-stats');

        window.addEventListener('resize', () => this.onWindowResize());
        Object.assign(window, { scene: this.scene });
    }

    #updateStockVis() {
        this.updateVis("stock", [generateStock(this.stockDiameter / 2, this.stockLength, this.baseZ)], this.showStockMesh);
    }

    /**
     * Load STL model
     * @param {string} fname Model filename
     */
    loadStl(fname) {
        const loader = new STLLoader();
        loader.load(
            `models/${fname}.stl`,
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
                this.updateVis("target", [new THREE.Mesh(geometry, material)]);
            },
            (xhr) => {
                console.log((xhr.loaded / xhr.total) * 100 + '% loaded')
            },
            (error) => {
                console.log(error);
            }
        );
    }

    copyGcode() {
        const prog = this.generateGcode();
        navigator.clipboard.writeText(prog);
    }

    sendGcodeToSim() {
        const prog = this.generateGcode();
        new BroadcastChannel("gcode").postMessage(prog);
    }

    /**
     * Generate G-code from plan path
     * @returns {string} Generated G-code
     */
    generateGcode() {
        const planPath = this.modPlanner.planPath;

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

    /**
     * Add visualizations to a visualization group.
     * @param {string} group Group identifier
     * @param {Array<THREE.Object3D>} vs Array of objects to add
     * @param {boolean} [visible=true] Whether the objects should be visible
     */
    addVis(group, vs, visible = true) {
        if (this.visGroups[group]) {
            for (const v of vs) {
                this.scene.add(v);
                this.visGroups[group].push(v);
                v.visible = visible;
            }
        }
    }

    /**
     * Update visualization group
     * @param {string} group Group identifier
     * @param {Array<THREE.Object3D>} vs Array of objects to visualize
     * @param {boolean} [visible=true] Whether the group should be visible
     */
    updateVis(group, vs, visible = true) {
        if (this.visGroups[group]) {
            this.visGroups[group].forEach(v => this.scene.remove(v));
        }
        vs.forEach(v => {
            this.scene.add(v);
            v.visible = visible;
        });
        this.visGroups[group] = vs;
    }

    /**
     * Set visibility of visualization group
     * @param {string} group Group identifier
     * @param {boolean} visible Whether the group should be visible
     */
    setVisVisibility(group, visible) {
        if (this.visGroups[group]) {
            this.visGroups[group].forEach(v => v.visible = visible);
        }
    }

    onWindowResize() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        this.renderer.setSize(width, height);
        this.composer.setSize(width, height);
    }

    animate() {
        this.modPlanner.animateHook();

        if (this.vlogErrors.length > this.lastNumVlogErrors) {
            console.warn(`${this.vlogErrors.length - this.lastNumVlogErrors} new errors`);
            this.lastNumVlogErrors = this.vlogErrors.length;
        }

        this.controls.update();
        this.composer.render();
        this.stats.update();
    }
}

(async () => {
    await loadFont();
    const view = new View3D();
})();
