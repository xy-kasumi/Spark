import * as THREE from 'three';

import Stats from 'three/addons/libs/stats.module.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

import { STLLoader } from 'three/addons/loaders/STLLoader.js';

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

let container, stats, gui, guiStatsEl;
let camera, controls, scene, renderer, material;

let objGeom = null;
let vis = [];

// voxel at (ix, iy, iz):
// * occupies volume: [ofs + i * res, ofs + (i + 1) * res)
// * has center: ofs + (i + 0.5) * res
class VoxelGrid {
    constructor(ofs, res, numX, numY, numZ) {
        this.ofs = ofs;
        this.res = res;
        this.numX = numX;
        this.numY = numY;
        this.numZ = numZ;
        this.data = new Uint8Array(numX * numY * numZ);
    }

    set(ix, iy, iz, val) {
        this.data[ix + iy * this.numX + iz * this.numX * this.numY] = val;
    }

    get(ix, iy, iz) {
        return this.data[ix + iy * this.numX + iz * this.numX * this.numY];
    }

    count() {
        let cnt = 0;
        for (let i = 0; i < this.data.length; i++) {
            if (this.data[i] !== 0) {
                cnt++;
            }
        }
        return cnt;
    }

    volume() {
        return this.count() * this.res * this.res * this.res;
    }
}

const Model = {
    GEAR: "Helical Gear",
    DICE_TOWER: "Dice Tower",
};

const dicer = {
    model: Model.GEAR,
    modelScale: 1,
    resMm: 1,
    sliceZ: 1,
    sliceY: 0,
    dice: () => {
        diceAndVisualize(objGeom);
    },
};

// surf: tri vertex list
const diceAndVisualize = (surf) => {
    // cleanup prev vis
    vis.forEach(v => scene.remove(v));
    vis = [];

    const MARGIN_MM = 1;

    // compute AABB
    const aabbMin = new THREE.Vector3(surf[0], surf[1], surf[2]);
    const aabbMax = new THREE.Vector3(surf[0], surf[1], surf[2]);
    for (let i = 1; i < surf.length / 3; i++) {
        const v = new THREE.Vector3(surf[3 * i + 0], surf[3 * i + 1], surf[3 * i + 2]);
        aabbMin.min(v);
        aabbMax.max(v);
    }
    console.log("AABB", aabbMin, aabbMax);
    
    aabbMin.subScalar(MARGIN_MM);
    aabbMax.addScalar(MARGIN_MM);
    const numV = aabbMax.clone().sub(aabbMin).divideScalar(dicer.resMm).ceil();
    console.log("VG size", numV);
    const vg = new VoxelGrid(aabbMin, dicer.resMm, numV.x, numV.y, numV.z);

    console.log("dicing...");
    for (let iz = 0; iz < vg.numZ; iz++) {
        const sliceZ = vg.ofs.z + (iz + 0.5) * vg.res;
        const cont = sliceSurfByPlane(surf, sliceZ);

        for (let iy = 0; iy < vg.numY; iy++) {
            const sliceY = vg.ofs.y + (iy + 0.5) * vg.res;
            const bnds = sliceContourByLine(cont, sliceY);

            let isOutside = true;
            for (let ix = 0; ix < vg.numX; ix++) {
                if (bnds.length === 0) {
                    vg.set(ix, iy, iz, 0);
                    continue;
                }

                const sliceX = vg.ofs.x + (ix + 0.5) * vg.res;

                if (bnds[0] <= sliceX) {
                    isOutside = !isOutside;
                    bnds.shift();
                }
                vg.set(ix, iy, iz, isOutside ? 0 : 255);
            }
        }
    }
    console.log(`dicing done; volume: ${vg.volume()} mm^3 (${vg.count()} voxels)`);
    const visVg = createVgVis(vg);
    scene.add(visVg);
    vis.push(visVg);

    // visualize specific slice
    const cont = sliceSurfByPlane(surf, dicer.sliceZ);
    const bnds = sliceContourByLine(cont, dicer.sliceY);

    const visContour = createContourVis(cont);
    scene.add(visContour);
    visContour.position.z = dicer.sliceZ;
    vis.push(visContour);

    const visBnd = createBndsVis(bnds);
    scene.add(visBnd);
    visBnd.position.y = dicer.sliceY;
    visBnd.position.z = dicer.sliceZ;
    vis.push(visBnd);
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

// contEdges: [x0, y0, x1, y1, ...]
// returns: seg set [x0, x1, x2, ...]
const sliceContourByLine = (contEdges, sliceY) => {
    const bnds = [];
    const numEdges = contEdges.length / 4;
    for (let i = 0; i < numEdges; i++) {
        const p0 = new THREE.Vector2(contEdges[4 * i + 0], contEdges[4 * i + 1]);
        const p1 = new THREE.Vector2(contEdges[4 * i + 2], contEdges[4 * i + 3]);

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
    let isOutside = true;
    let numFixes = 0;
    bnds.forEach(b => {
        if (isOutside && b.isEnter) {
            bndsClean.push(b.x);
            isOutside = false;
        } else if (!isOutside && !b.isEnter) {
            bndsClean.push(b.x);
            isOutside = true;
        } else {
            // messed up data -> interpret as largest bnds
            if (b.isEnter) {
                // ignore (use previous enter)
                numFixes++;
            } else {
                // discard previous one
                bndsClean.pop();
                bndsClean.push(b.x);
                numFixes++;
            }
        }
    });
    if (numFixes > 0) {
        // console.warn(`Fixed ${numFixes} contour boundaries by heuristic`);
    }

    return bndsClean;
};


// surfTris: [x0, y0, z0, x1, y1, z1, ...]
// returns: contour edges
const sliceSurfByPlane = (surfTris, sliceZ) => {
    const segs = [];

    // tris are CCW.
    const numTris = surfTris.length / 9;
    for (let i = 0; i < numTris; i++) {
        const p0 = new THREE.Vector3(surfTris[9 * i + 0], surfTris[9 * i + 1], surfTris[9 * i + 2]);
        const p1 = new THREE.Vector3(surfTris[9 * i + 3], surfTris[9 * i + 4], surfTris[9 * i + 5]);
        const p2 = new THREE.Vector3(surfTris[9 * i + 6], surfTris[9 * i + 7], surfTris[9 * i + 8]);

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


const loader = new STLLoader();
loader.load(
    'models/Dice Tower.stl',
    //'models/helical_gear.stl',
    function (geometry) {
        objGeom = geometry.getAttribute("position").array;

        const material = new THREE.MeshPhysicalMaterial({
            color: 0xb2ffc8,
            metalness: 0.1,
            roughness: 0.8,
            transparent: true,
            opacity: 0.1,
        });

        const mesh = new THREE.Mesh(geometry, material)
        scene.add(mesh)
    },
    (xhr) => {
        console.log((xhr.loaded / xhr.total) * 100 + '% loaded')
    },
    (error) => {
        console.log(error)
    }
);



//

init();
initMesh();

//

function clean() {

    const meshes = [];

    scene.traverse(function (object) {

        if (object.isMesh) meshes.push(object);

    });

    for (let i = 0; i < meshes.length; i++) {

        const mesh = meshes[i];
        mesh.material.dispose();
        mesh.geometry.dispose();

        scene.remove(mesh);

    }

}

// returns: THREE.Object3D
const createContourVis = (edges) => {
    const geom = new THREE.BufferGeometry();
    const vertices = new Float32Array(edges.length / 2 * 3);
    for (let i = 0; i < edges.length / 2; i++) {
        vertices[3 * i + 0] = edges[2 * i + 0];
        vertices[3 * i + 1] = edges[2 * i + 1];
        vertices[3 * i + 2] = 0;
    }
    geom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));

    const matEdges = new THREE.LineBasicMaterial({ color: 0x8080a0 });
    const objEdges = new THREE.LineSegments(geom, matEdges);
    const objPoints = new THREE.Points(geom, new THREE.PointsMaterial({ color: 0x8080f0, size: 3 }));
    objEdges.add(objPoints);

    return objEdges;
};

// returns: THREE.Object3D
const createBndsVis = (bnds) => {
    const geom = new THREE.BufferGeometry();
    const vertices = new Float32Array(bnds.length * 3);
    for (let i = 0; i < bnds.length; i++) {
        vertices[3 * i + 0] = bnds[i];
        vertices[3 * i + 1] = 0;
        vertices[3 * i + 2] = 0;
    }
    geom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));

    const matEdges = new THREE.LineBasicMaterial({ color: 0x80a080 });
    const objEdges = new THREE.LineSegments(geom, matEdges);
    const objPoints = new THREE.Points(geom, new THREE.PointsMaterial({ color: 0x80f080, size: 3 }));
    objEdges.add(objPoints);

    return objEdges;
};

// returns: THREE.Object3D
const createVgVis = (vg) => {
    const cubeGeom = new THREE.BoxGeometry(dicer.resMm * 0.9, dicer.resMm * 0.9, dicer.resMm * 0.9);

    const num = vg.count();
    const mesh = new THREE.InstancedMesh(cubeGeom, new THREE.MeshNormalMaterial({ color: 0x707070,}), num);
    let instanceIx = 0;
    for (let iz = 0; iz < vg.numZ; iz++) {
        for (let iy = 0; iy < vg.numY; iy++) {
            for (let ix = 0; ix < vg.numX; ix++) {
                if (vg.get(ix, iy, iz) === 0) {
                    continue;
                }

                const mtx = new THREE.Matrix4();
                mtx.setPosition(new THREE.Vector3(ix, iy, iz).addScalar(0.5).multiplyScalar(vg.res).add(vg.ofs));
                mesh.setMatrixAt(instanceIx, mtx);
                instanceIx++;
            }
        }
    }
    console.log(instanceIx, num);
    return mesh;
};


function initMesh() {
    clean();

}



function init() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    // camera
    const aspect = width / height;
    camera = new THREE.OrthographicCamera(-50 * aspect, 50 * aspect, 50, -50, 0.1, 300);
    camera.position.x = -100;
    camera.position.y = -100;
    camera.position.z = 100;
    camera.up.set(0, 0, 1);

    // renderer

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    renderer.setAnimationLoop(animate);
    container = document.getElementById('container');
    container.appendChild(renderer.domElement);

    // scene (scene is in mm unit)

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);

    const light = new THREE.AmbientLight(0x404040); // soft white light
    scene.add(light);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
    scene.add(directionalLight);

    const gridHelper = new THREE.GridHelper(100, 10);
    scene.add(gridHelper);
    gridHelper.rotateX(Math.PI / 2);

    const axesHelper = new THREE.AxesHelper(8);
    scene.add(axesHelper);
    axesHelper.position.set(-49, -49, 0);

    // controls

    controls = new OrbitControls(camera, renderer.domElement);

    // stats

    stats = new Stats();
    container.appendChild(stats.dom);

    // gui

    gui = new GUI();
    gui.add(dicer, 'model', Model).onChange(initMesh);
    gui.add(dicer, 'modelScale', [0.01, 0.1, 1, 10, 100]).step(1).onChange(initMesh);
    gui.add(dicer, "resMm", [1e-3, 1e-2, 1e-1, 1]);
    gui.add(dicer, "sliceZ", -10, 50).step(0.1);
    gui.add(dicer, "sliceY", -50, 50).step(0.1);
    gui.add(dicer, "dice");

    guiStatsEl = document.createElement('div');
    guiStatsEl.classList.add('gui-stats');


    // listeners

    window.addEventListener('resize', onWindowResize);

    Object.assign(window, { scene });

}

//

function onWindowResize() {

    const width = window.innerWidth;
    const height = window.innerHeight;

    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    renderer.setSize(width, height);

}

function animate() {

    controls.update();

    renderer.render(scene, camera);

    stats.update();

}
