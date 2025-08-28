// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from 'three';

/**
 * Opaque handle to a Manifold instance. Must be destroyed via WasmGeom.destroyManifold().
 * Always non-nullptr.
 */
export type ManifoldHandle = number & { __brand: 'ManifoldHandle' };

/**
 * Opaque handle to a CrossSection instance. Must be destroyed via WasmGeom.destroyCrossSection().
 * Always non-nullptr.
 */
export type CrossSectionHandle = number & { __brand: 'CrossSectionHandle' };

export class WasmGeom {
    module: any; // imported WASM module

    constructor(module: any) {
        this.module = module;
    }

    /**
     * Allocate and populate a Vector3 in WASM memory
     * @returns Pointer to allocated memory (must be freed)
     */
    private allocVector3(vec: THREE.Vector3): number {
        const ptr = this.module._malloc(12);
        this.module.HEAPF32.set([vec.x, vec.y, vec.z], ptr / 4);
        return ptr;
    }

    /**
     * Read contours data from WASM memory
     * @param resultPtr Pointer to contours struct
     * @returns Array of contours (each contour is an array of 2D points)
     */
    private readContours(resultPtr: number): THREE.Vector2[][] {
        const Module = this.module;
        const numContours = Module.getValue(resultPtr, 'i32');
        const contoursPtr = Module.getValue(resultPtr + 4, 'i32');

        const contours: THREE.Vector2[][] = [];
        for (let i = 0; i < numContours; i++) {
            const contourPtr = contoursPtr + i * 8;
            const numPoints = Module.getValue(contourPtr, 'i32');
            const pointsPtr = Module.getValue(contourPtr + 4, 'i32');

            const contour: THREE.Vector2[] = [];
            for (let j = 0; j < numPoints; j++) {
                const pointPtr = pointsPtr + j * 8;
                const x = Module.HEAPF32[pointPtr / 4];
                const y = Module.HEAPF32[pointPtr / 4 + 1];
                contour.push(new THREE.Vector2(x, y));
            }
            contours.push(contour);
        }

        return contours;
    }

    /**
     * Create a Manifold handle from a geometry
     * @param geometry - Input geometry to convert to manifold
     * @returns ManifoldHandle or null if creation failed
     */
    createManifold(geometry: THREE.BufferGeometry): ManifoldHandle | null {
        const Module = this.module;
        const triSoup = toTriSoup(geometry);
        const numVertices = triSoup.length / 3;

        // Allocate triangle_soup struct
        const soupPtr = Module._malloc(8);
        const verticesPtr = Module._malloc(numVertices * 12); // 3 floats * 4 bytes per vertex

        // Fill vertex data
        for (let i = 0; i < numVertices; i++) {
            Module.HEAPF32[(verticesPtr / 4) + i * 3] = triSoup[i * 3];
            Module.HEAPF32[(verticesPtr / 4) + i * 3 + 1] = triSoup[i * 3 + 1];
            Module.HEAPF32[(verticesPtr / 4) + i * 3 + 2] = triSoup[i * 3 + 2];
        }
        Module.HEAP32[soupPtr / 4] = numVertices;
        Module.HEAP32[(soupPtr / 4) + 1] = verticesPtr;

        try {
            const manifoldPtr = Module._create_manifold_from_trisoup(soupPtr);
            if (manifoldPtr === 0) {
                return null;
            }
            return manifoldPtr as ManifoldHandle;
        } finally {
            Module._free(soupPtr);
            Module._free(verticesPtr);
        }
    }

    destroyManifold(handle: ManifoldHandle) {
        this.module._destroy_manifold(handle);
    }

    destroyCrossSection(handle: CrossSectionHandle) {
        this.module._destroy_crosssection(handle);
    }

    /**
     * Convert ManifoldHandle to BufferGeometry
     */
    manifoldToGeometry(handle: ManifoldHandle): THREE.BufferGeometry | null {
        const Module = this.module;
        const resultPtr = Module._manifold_to_trisoup(handle);
        if (!resultPtr) return null;

        try {
            const numVerts = Module.getValue(resultPtr, 'i32');
            const verticesPtr = Module.getValue(resultPtr + 4, 'i32');

            const result = new Float64Array(numVerts * 3);
            for (let i = 0; i < numVerts; i++) {
                // Each vertex is a vector3 (3 floats)
                const vertexPtr = verticesPtr + i * 12; // 12 bytes per vector3
                result[i * 3] = Module.HEAPF32[vertexPtr / 4];       // x
                result[i * 3 + 1] = Module.HEAPF32[vertexPtr / 4 + 1]; // y
                result[i * 3 + 2] = Module.HEAPF32[vertexPtr / 4 + 2]; // z
            }

            return fromTriSoup(result);
        } finally {
            Module._free_triangle_soup(resultPtr);
        }
    }

    /**
     * Project manifold to CrossSection
     */
    projectManifold(
        handle: ManifoldHandle,
        origin: THREE.Vector3,
        viewX: THREE.Vector3,
        viewY: THREE.Vector3,
        viewZ: THREE.Vector3
    ): CrossSectionHandle | null {
        const originPtr = this.allocVector3(origin);
        const viewXPtr = this.allocVector3(viewX);
        const viewYPtr = this.allocVector3(viewY);
        const viewZPtr = this.allocVector3(viewZ);

        try {
            const resultPtr = this.module._project_manifold(handle, originPtr, viewXPtr, viewYPtr, viewZPtr);
            return resultPtr ? resultPtr as CrossSectionHandle : null;
        } finally {
            this.module._free(originPtr);
            this.module._free(viewXPtr);
            this.module._free(viewYPtr);
            this.module._free(viewZPtr);
        }
    }

    /**
     * Apply offset to a CrossSection
     */
    offsetCrossSection(handle: CrossSectionHandle, offset: number): CrossSectionHandle | null {
        const resultPtr = this.module._offset_crosssection(handle, offset);
        return resultPtr ? resultPtr as CrossSectionHandle : null;
    }

    /**
     * Apply circular offset to a CrossSection with specified segment count
     */
    offsetCrossSectionCircle(handle: CrossSectionHandle, offset: number, circularSegs: number): CrossSectionHandle | null {
        const resultPtr = this.module._offset_crosssection_circle(handle, offset, circularSegs);
        return resultPtr ? resultPtr as CrossSectionHandle : null;
    }

    /**
     * Subtract one CrossSection from another
     */
    subtractCrossSection(csA: CrossSectionHandle, csB: CrossSectionHandle): CrossSectionHandle | null {
        const resultPtr = this.module._subtract_crosssection(csA, csB);
        return resultPtr ? resultPtr as CrossSectionHandle : null;
    }

    /**
     * Create a square CrossSection with given size, centered at origin
     */
    createSquareCrossSection(size: number): CrossSectionHandle | null {
        const resultPtr = this.module._create_square_crosssection(size);
        return resultPtr ? resultPtr as CrossSectionHandle : null;
    }

    /**
     * Extract outermost contours from a CrossSection
     */
    outermostCrossSection(handle: CrossSectionHandle): CrossSectionHandle | null {
        const resultPtr = this.module._outermost_crosssection(handle);
        return resultPtr ? resultPtr as CrossSectionHandle : null;
    }

    /**
     * Convert CrossSection to contours
     */
    crossSectionToContours(handle: CrossSectionHandle): THREE.Vector2[][] {
        const resultPtr = this.module._crosssection_to_contours(handle);
        if (!resultPtr) {
            throw new Error("crosssection_to_contours failed");
        }

        const contours = this.readContours(resultPtr);
        this.module._free_contours(resultPtr);
        return contours;
    }

    /**
     * Extrude CrossSection to create a Manifold
     */
    extrude(
        handle: CrossSectionHandle,
        coordX: THREE.Vector3,
        coordY: THREE.Vector3,
        coordZ: THREE.Vector3,
        origin: THREE.Vector3,
        length: number
    ): ManifoldHandle | null {
        const coordXPtr = this.allocVector3(coordX);
        const coordYPtr = this.allocVector3(coordY);
        const coordZPtr = this.allocVector3(coordZ);
        const originPtr = this.allocVector3(origin);

        try {
            const resultPtr = this.module._extrude(handle, coordXPtr, coordYPtr, coordZPtr, originPtr, length);
            return resultPtr ? resultPtr as ManifoldHandle : null;
        } finally {
            this.module._free(coordXPtr);
            this.module._free(coordYPtr);
            this.module._free(coordZPtr);
            this.module._free(originPtr);
        }
    }

    /**
     * Project manifold to 2D contours using ManifoldHandle
     */
    projectMesh(
        handle: ManifoldHandle,
        origin: THREE.Vector3,
        viewX: THREE.Vector3,
        viewY: THREE.Vector3,
        viewZ: THREE.Vector3,
        offset: number = 1.5,
        onlyOutermost: boolean = true
    ): THREE.Vector2[][] {
        const crossSection = this.projectManifold(handle, origin, viewX, viewY, viewZ);
        if (!crossSection) {
            throw new Error("project_manifold failed");
        }

        let currentCS = crossSection;
        try {
            if (offset !== 0) {
                const offsetCS = this.offsetCrossSection(currentCS, offset);
                if (!offsetCS) {
                    throw new Error("offset_crosssection failed");
                }
                this.destroyCrossSection(currentCS);
                currentCS = offsetCS;
            }

            if (onlyOutermost) {
                const outermostCS = this.outermostCrossSection(currentCS);
                if (!outermostCS) {
                    throw new Error("outermost_crosssection failed");
                }
                this.destroyCrossSection(currentCS);
                currentCS = outermostCS;
            }

            return this.crossSectionToContours(currentCS);
        } finally {
            this.destroyCrossSection(currentCS);
        }
    }

    /**
     * Subtract manifolds using handles, returns new ManifoldHandle
     */
    subtractMesh(
        handleA: ManifoldHandle,
        handleB: ManifoldHandle
    ): ManifoldHandle | null {
        const resultPtr = this.module._subtract_manifolds(handleA, handleB);
        return resultPtr ? resultPtr as ManifoldHandle : null;
    }

    /**
     * Intersect manifolds using handles, returns new ManifoldHandle
     */
    intersectMesh(
        handleA: ManifoldHandle,
        handleB: ManifoldHandle
    ): ManifoldHandle | null {
        const resultPtr = this.module._intersect_manifolds(handleA, handleB);
        return resultPtr ? resultPtr as ManifoldHandle : null;
    }
}

export async function initWasmGeom(): Promise<WasmGeom> {
    // @ts-ignore - WASM module will be generated at build time
    const WasmGeomModule = (await import('./wasm/wasm_geom.js')).default;

    let moduleInstance: any = null;
    moduleInstance = await WasmGeomModule({
        env: {
            wasmLog: function (msgPtr: number) {
                const msg = moduleInstance.UTF8ToString(msgPtr);
                wasmLog(msg);
            },
            wasmBeginPerf: function (tagPtr: number) {
                const tag = moduleInstance.UTF8ToString(tagPtr);
                wasmBeginPerf(tag);
            },
            wasmEndPerf: function (tagPtr: number) {
                const tag = moduleInstance.UTF8ToString(tagPtr);
                wasmEndPerf(tag);
            }
        }
    });
    return new WasmGeom(moduleInstance);
}

const perfMap = new Map<string, number>();

function wasmLog(msg: string) {
    console.log(msg);
}

function wasmBeginPerf(tag: string) {
    perfMap.set(tag, performance.now());
}

function wasmEndPerf(tag: string) {
    const startTime = perfMap.get(tag);
    if (startTime !== undefined) {
        const endTime = performance.now();
        const duration = endTime - startTime;
        console.log(`[${tag}] ${duration.toFixed(2)}ms`);
        perfMap.delete(tag);
    } else {
        console.warn(`[${tag}] No matching beginPerf found`);
    }
}

/**
 * Convert BufferGeometry to "triangle soup" representation
 * @param geom Input geometry
 * @returns Triangle soup array
 */
export function toTriSoup(geom: THREE.BufferGeometry): Float64Array {
    if (geom.index === null) {
        console.log("toTriSoup: converting from non-indexed geometry");
        const posArray = geom.getAttribute("position").array;
        return new Float64Array(posArray);
    } else {
        console.log("toTriSoup: converting from indexed geometry");
        const ix = geom.index.array;
        const pos = geom.getAttribute("position").array;

        const numTris = ix.length / 3;
        const buf = new Float64Array(numTris * 9);
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
}

/**
 * Convert triangle soup to BufferGeometry.
 * @param triSoup Triangle soup array
 */
function fromTriSoup(triSoup: Float64Array): THREE.BufferGeometry {
    const positions = new Float32Array(triSoup.length);
    for (let i = 0; i < triSoup.length; i++) {
        positions[i] = triSoup[i];
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    return geometry;
}
