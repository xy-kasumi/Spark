// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from 'three';

/**
 * Opaque handle to a Manifold instance. Must be destroyed via WasmGeom.destroyManifold().
 * Always non-nullptr.
 */
export type ManifoldHandle = number & { __brand: 'ManifoldHandle' };

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
     * Project manifold to 2D contours using ManifoldHandle
     */
    projectMeshFromHandle(
        handle: ManifoldHandle,
        origin: THREE.Vector3,
        viewX: THREE.Vector3,
        viewY: THREE.Vector3,
        viewZ: THREE.Vector3
    ): THREE.Vector2[][] {
        const Module = this.module;
        
        const originPtr = this.allocVector3(origin);
        const viewXPtr = this.allocVector3(viewX);
        const viewYPtr = this.allocVector3(viewY);
        const viewZPtr = this.allocVector3(viewZ);
        
        try {
            const resultPtr = Module._project_manifold(handle, originPtr, viewXPtr, viewYPtr, viewZPtr, 1.5, true);
            if (!resultPtr) throw new Error("project_manifold failed - check console for details");
            
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
            
            Module._free_contours(resultPtr);
            return contours;
        } finally {
            Module._free(originPtr);
            Module._free(viewXPtr);
            Module._free(viewYPtr);
            Module._free(viewZPtr);
        }
    }
    
    /**
     * Subtract manifolds using handles, returns new ManifoldHandle
     */
    subtractMeshFromHandles(
        handleA: ManifoldHandle,
        handleB: ManifoldHandle
    ): ManifoldHandle | null {
        const resultPtr = this.module._subtract_manifolds(handleA, handleB);
        return resultPtr ? resultPtr as ManifoldHandle : null;
    }

    /**
     * Project mesh geometry to 2D contours using WASM
     * @param geometry - Input geometry to project
     * @param origin - 3D origin point for projection plane
     * @param viewX - X axis of projection coordinate system (must be orthonormal)
     * @param viewY - Y axis of projection coordinate system (must be orthonormal)
     * @param viewZ - Z axis of projection coordinate system (viewing direction, must be orthonormal)
     * @returns Array of contours (each contour is an array of 2D points)
     */
    projectMesh(
        geometry: THREE.BufferGeometry,
        origin: THREE.Vector3,
        viewX: THREE.Vector3,
        viewY: THREE.Vector3,
        viewZ: THREE.Vector3
    ): THREE.Vector2[][] {
        const handle = this.createManifold(geometry);
        if (!handle) throw new Error("Failed to create manifold");
        
        try {
            return this.projectMeshFromHandle(handle, origin, viewX, viewY, viewZ);
        } finally {
            this.destroyManifold(handle);
        }
    }

    /**
     * Subtract one mesh from another using WASM Manifold
     * @param geometryA - First geometry (minuend)
     * @param geometryB - Second geometry to subtract from first (subtrahend)
     * @returns Resulting geometry (A - B)
     */
    subtractMesh(
        geometryA: THREE.BufferGeometry,
        geometryB: THREE.BufferGeometry
    ): THREE.BufferGeometry {
        const handleA = this.createManifold(geometryA);
        const handleB = this.createManifold(geometryB);
        
        if (!handleA || !handleB) {
            if (handleA) this.destroyManifold(handleA);
            if (handleB) this.destroyManifold(handleB);
            throw new Error("Failed to create manifolds");
        }
        
        try {
            const resultHandle = this.subtractMeshFromHandles(handleA, handleB);
            if (!resultHandle) throw new Error("Subtraction failed");
            
            try {
                const result = this.manifoldToGeometry(resultHandle);
                if (!result) throw new Error("Failed to convert result to geometry");
                return result;
            } finally {
                this.destroyManifold(resultHandle);
            }
        } finally {
            this.destroyManifold(handleA);
            this.destroyManifold(handleB);
        }
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
