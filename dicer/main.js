import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let container, stats, gui, guiStatsEl;
let camera, controls, scene, renderer, material;

let objGeom = null;

let visNonVg = [];
let visVg = null;
let visObj = null;

let ctrlShowVoxels;

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
    HELICAL_GEAR: "helical_gear",
    DICE_TOWER: "dice_tower",
};

const dicer = {
    model: Model.HELICAL_GEAR,
    resMm: 0.5,
    lineZ: 1,
    lineY: 0,
    showVoxels: false,
    dice: () => {
        diceAndVisualize(objGeom, dicer.resMm);
    },
    diceLine: () => {
        diceLineAndVisualize(objGeom, dicer.lineY, dicer.lineZ);
    },
    toolX: 0,
    toolY: 0,
    toolZ: 0,
};

// surf: tri vertex list
const diceAndVisualize = (surf, resMm) => {
    // cleanup prev vis
    if (visVg) {
        scene.remove(visVg);
    }
    visVg = null;

    const vg = diceSurf(surf, resMm);
    visVg = createVgVis(vg);
    ctrlShowVoxels.setValue(true);
    scene.add(visVg);
};

const diceLineAndVisualize = (surf, lineY, lineZ) => {
    // cleanup prev vis
    visNonVg.forEach(v => scene.remove(v));
    visNonVg = [];

    // slice specific (Y, Z) line.
    const cont = sliceSurfByPlane(surf, lineZ);
    const bnds = sliceContourByLine(cont, lineY);

    // visualize
    const visContour = createContourVis(cont);
    scene.add(visContour);
    visContour.position.z = lineZ;
    visNonVg.push(visContour);

    const visBnd = createBndsVis(bnds);
    scene.add(visBnd);
    visBnd.position.y = lineY;
    visBnd.position.z = lineZ;
    visNonVg.push(visBnd);
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

const diceSurf = (surf, resMm) => {
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
    const numV = aabbMax.clone().sub(aabbMin).divideScalar(resMm).ceil();
    console.log("VG size", numV);
    const vg = new VoxelGrid(aabbMin, resMm, numV.x, numV.y, numV.z);

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
    return vg;
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
                console.error("Corrupt surface data (hole)");
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

const loadStl = (fname) => {
    const loader = new STLLoader();
    loader.load(
        `models/${fname}.stl`,
        function (geometry) {
            objGeom = geometry.getAttribute("position").array;
    
            const material = new THREE.MeshPhysicalMaterial({
                color: 0xb2ffc8,
                metalness: 0.1,
                roughness: 0.8,
                transparent: true,
                opacity: 0.1,
            });

            if (visObj) {
                scene.remove(visObj);
                visObj = null;
            }
    
            const mesh = new THREE.Mesh(geometry, material)
            scene.add(mesh);
            visObj = mesh;
        },
        (xhr) => {
            console.log((xhr.loaded / xhr.total) * 100 + '% loaded')
        },
        (error) => {
            console.log(error)
        }
    );
};



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
    const mesh = new THREE.InstancedMesh(cubeGeom, new THREE.MeshNormalMaterial(), num);
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

const generateTool = () => {
    // 25G needle
    const needleExtRadius = 0.51 / 2;
    const needleLength = 25;
    const wireRadius = 0.25 / 2;
    const wireExtrusion = wireRadius * 2;

    const needle = new THREE.Mesh(
        new THREE.CylinderGeometry(needleExtRadius, needleExtRadius, needleLength, 32, 1),
        new THREE.MeshPhysicalMaterial({color: 0xf0f0f0, metalness: 0.9, roughness: 0.3}));
    needle.position.y = needleLength / 2;

    const wire = new THREE.Mesh(
        new THREE.CylinderGeometry(wireRadius, wireRadius, wireExtrusion, 16, 1),
        new THREE.MeshPhysicalMaterial({color: "red", metalness: 0.9, roughness: 0.7}));
    needle.add(wire);
    wire.position.y = needleLength / 2 + wireExtrusion / 2;

    return needle;
};


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

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(0, 0, 1);
    scene.add(directionalLight);

    const hemiLight = new THREE.HemisphereLight( 0xffffbb, 0x080820, 1 );
    scene.add(hemiLight);

    const gridHelper = new THREE.GridHelper(100, 10);
    scene.add(gridHelper);
    gridHelper.rotateX(Math.PI / 2);

    const axesHelper = new THREE.AxesHelper(8);
    scene.add(axesHelper);
    axesHelper.position.set(-49, -49, 0);

    // tool
    const tool = generateTool();
    scene.add(tool);

    // controls

    controls = new OrbitControls(camera, renderer.domElement);

    // stats

    stats = new Stats();
    container.appendChild(stats.dom);

    // gui

    gui = new GUI();
    gui.add(dicer, 'model', Model).onChange((model) => {
        // delete vis
        if (visVg) {
            scene.remove(visVg);
        }
        visVg = null;

        visNonVg.forEach(v => scene.remove(v));
        visNonVg = [];

        // load new model
        loadStl(model);
    });
    gui.add(dicer, "resMm", [1e-3, 1e-2, 1e-1, 0.25, 0.5, 1]);
    ctrlShowVoxels = gui.add(dicer, "showVoxels").onChange(v => {
        if (visVg) {
            visVg.visible = v;
        }
    });
    gui.add(dicer, "dice");

    gui.add(dicer, "lineZ", -10, 50).step(0.1);
    gui.add(dicer, "lineY", -50, 50).step(0.1);
    gui.add(dicer, "diceLine");

    gui.add(dicer, "toolX", -50, 50).step(0.1).onChange(v => tool.position.x = v);
    gui.add(dicer, "toolY", -50, 50).step(0.1).onChange(v => tool.position.y = v);
    gui.add(dicer, "toolZ", 0, 100).step(0.1).onChange(v => tool.position.z = v);

    guiStatsEl = document.createElement('div');
    guiStatsEl.classList.add('gui-stats');


    // listeners
    window.addEventListener('resize', onWindowResize);
    Object.assign(window, { scene });
}

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

loadStl(dicer.model);
init();
