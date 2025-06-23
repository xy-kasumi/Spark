// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Pure" computation for tracking removal of work using VoxelGridGpu.
 */
import { createELHShape, createCylinderShape, VoxelGridGpu, GpuKernels, Shape, Boundary } from './gpu-geom.js';
import { VoxelGridCpu } from './cpu-geom.js';
import { Vector3 } from 'three';
import { debug, visDot } from './debug.js';

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
export class TrackingVoxelGrid {
    kernels: GpuKernels;
    res: number;
    numX: number;
    numY: number; 
    numZ: number;
    ofs: Vector3;
    vx: VoxelGridGpu;
    distField: VoxelGridGpu;
    cacheHasWork: VoxelGridGpu;
    cacheBlocked: VoxelGridGpu;
    protectedWorkBelowZ: number;

    constructor(kernels: GpuKernels) {
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
     * @param work VoxelGrid (0: empty, 128: partial, 255: full)
     * @param target VoxelGrid (0: empty, 128: partial, 255: full)
     * @async
     */
    async setFromWorkAndTarget(work: VoxelGridCpu, target: VoxelGridCpu): Promise<void> {
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
                            throw `Unknown target value: ${target.data[ixFlat]}`;
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
                            throw `Unknown work value: ${work.data[ixFlat]}`;
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
     * @param z Z+ in work coords.
     * @async
     */
    async setProtectedWorkBelowZ(z: number): Promise<void> {
        this.protectedWorkBelowZ = z;
        const tempVg = this.kernels.createLike(this.vx);
        await this.kernels.copy(this.vx, tempVg);
        this.kernels.map("set_protected_work_below_z", tempVg, this.vx, { "thresh_z": z });
        this.kernels.destroy(tempVg);
        this.#updateWorkDependentCache();
    }

    /**
     * Extract work volume as voxels. Each cell will contain deviation from target shape.
     * Positive value indicates deviation. 0 for perfect finish or inside. -1 for empty regions.
     * Caller must destroy the returned voxel grid.
     * 
     * @param excludeProtectedWork If true, exclude protected work.
     * @returns (f32)
     */
    extractWorkWithDeviation(excludeProtectedWork: boolean = false): VoxelGridGpu {
        let zThresh = excludeProtectedWork ? this.protectedWorkBelowZ + this.res : -1e3; // +this.res ensures removal of cells just at the Z boundary.
        const res = this.kernels.createLike(this.vx, "f32");
        this.kernels.map2("work_deviation", this.distField, this.vx, res, { "vx_diag": this.res * Math.sqrt(3), "exclude_below_z": zThresh });
        return res;
    }

    /**
     * Extract work volume as voxels. Each cell will contain 1 if it has work, 0 otherwise.
     * @param excludeProtectedWork 
     * @returns (u32) 1 exists
     */
    extractWorkFlag(excludeProtectedWork: boolean = false): VoxelGridGpu {
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
     * @returns (0: empty, 128: partial, 255: full)
     * @async
     */
    async extractTarget(): Promise<VoxelGridCpu> {
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
     * @param minShapes array of shapes, treated as union of all shapes
     * @param maxShapes array of shapes, treated as union of all shapes
     * @param ignoreOvercutErrors if true, ignore overcut errors. Hack to get final cut done.
     * @returns volume of neewly removed work.
     * @async
     */
    async commitRemoval(minShapes: Shape[], maxShapes: Shape[], ignoreOvercutErrors: boolean = false): Promise<number> {
        console.log("Commit removal", minShapes, maxShapes);
        const minVg = this.kernels.createLike(this.vx, "u32");
        const maxVg = this.kernels.createLike(this.vx, "u32");
        for (const shape of minShapes) {
            await this.kernels.fillShape(shape, minVg, Boundary.In);
        }
        for (const shape of maxShapes) {
            await this.kernels.fillShape(shape, maxVg, Boundary.Out);
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

        return (numRemoved as number) * this.res ** 3;
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
     * @returns volume of remaining work.
     * @async
     */
    async getRemainingWorkVol(): Promise<number> {
        const flagVg = this.kernels.createLike(this.vx, "u32");
        this.kernels.map("work_remaining", this.vx, flagVg);
        const cnt = await this.kernels.reduce("sum", flagVg);
        this.kernels.destroy(flagVg);
        return (cnt as number) * this.res ** 3;
    }

    /**
     * Returns range of the work in normal direction conservatively.
     * Conservative means: "no-work" region never has work, despite presence of quantization error.
     * 
     * @param dir Unit direction vector, in work coords.
     * @returns Offsets. No work exists outside the range.
     * @async
     */
    async queryWorkRange(dir: Vector3): Promise<{min: number, max: number}> {
        const work = this.kernels.createLike(this.vx, "u32");
        this.kernels.map("work_remaining", this.vx, work);
        const result = await this.kernels.boundOfAxis(dir, work, Boundary.Out);
        this.kernels.destroy(work);
        return result;
    }

    /**
     * Returns true if given shape contains cut-forbidden parts.
     * Conservative: voxels with potential overlaps will be considered for block-detection.
     * @param shape Shape object, created by {@link createCylinderShape}, {@link createELHShape}, etc.
     * @returns true if blocked, false otherwise
     * @async
     */
    async queryBlocked(shape: Shape): Promise<boolean> {
        return await this.kernels.countInShape(shape, this.cacheBlocked, Boundary.Out) > 0;
    }

    /**
     * Returns true if given shape contains work to do. Does not guarantee it's workable (not blocked).
     * 
     * @param shape Shape object, created by {@link createCylinderShape}, {@link createELHShape}, etc.
     * @returns true if has work, false otherwise
     * @async
     */
    async queryHasWork(shape: Shape): Promise<boolean> {
        return await this.kernels.countInShape(shape, this.cacheHasWork, Boundary.Nearest) > 0;
    }

    /**
     * Much faster way to get result for multiple {@link queryBlocked} or {@link queryHasWork} calls.
     * 
     * @param queries 
     * @returns results
     * @async
     */
    async parallelQuery(queries: {shape: Shape, query: "blocked" | "has_work"}[]): Promise<boolean[]> {
        const resultBuf = this.kernels.createBuffer(4 * queries.length);
        for (let i = 0; i < queries.length; i++) {
            const { shape, query } = queries[i];
            const offset = i * 4;
            if (query === "blocked") {
                this.kernels.countInShapeRaw(shape, this.cacheBlocked, Boundary.Out, resultBuf, offset);
            } else if (query === "has_work") {
                this.kernels.countInShapeRaw(shape, this.cacheHasWork, Boundary.Nearest, resultBuf, offset);
            } else {
                throw `Invalid query type: ${query}`;
            }
        }
        const readBuf = this.kernels.createBufferForCpuRead(4 * queries.length);
        await this.kernels.copyBuffer(resultBuf, readBuf);
        resultBuf.destroy();
        await readBuf.mapAsync(GPUMapMode.READ);
        const data = new Uint32Array(readBuf.getMappedRange());
        const results = Array.from(data).map(v => v > 0);
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
     * @param ix X coordinate
     * @param iy Y coordinate
     * @param iz Z coordinate
     * @returns Center point of cell
     */
    #centerOf(ix: number, iy: number, iz: number): Vector3 {
        return new Vector3(ix, iy, iz).addScalar(0.5).multiplyScalar(this.res).add(this.ofs);
    }
}

/**
 * Compute AABB from points array
 * @param pts Points array [x0, y0, z0, x1, y1, z1, ...]
 * @returns AABB bounds
 */
export const computeAABB = (pts: Float32Array): {min: Vector3, max: Vector3} => {
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
 * Initialize voxel grid for storing points
 * @param pts Points array [x0, y0, z0, x1, y1, z1, ...]
 * @param resMm Voxel resolution
 * @returns Initialized voxel grid
 */
export const initVGForPoints = (pts: Float32Array, resMm: number): VoxelGridCpu => {
    const MARGIN_MM = resMm; // want to keep boundary one voxel clear to avoid any mishaps. resMm should be enough.
    const { min, max } = computeAABB(pts);
    const center = min.clone().add(max).divideScalar(2);

    min.subScalar(MARGIN_MM);
    max.addScalar(MARGIN_MM);

    const numV = max.clone().sub(min).divideScalar(resMm).ceil();
    const gridMin = center.clone().sub(numV.clone().multiplyScalar(resMm / 2));
    return new VoxelGridCpu(resMm, numV.x, numV.y, numV.z, gridMin);
};

