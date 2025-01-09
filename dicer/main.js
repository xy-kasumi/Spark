import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import {
    initVG, initVGForPoints, diceSurf, sliceSurfByPlane, sliceContourByLine,
    resampleVG,
} from './geom.js';

const fontLoader = new FontLoader();
let font = null;

// Apply translation to geometry in-place.
// [in]: THREE.BufferGeometry
// [in]: THREE.Vector3
const translateGeom = (geom, trans) => {
    const pos = geom.getAttribute("position").array;
    for (let i = 0; i < pos.length; i += 3) {
        pos[i + 0] += trans.x;
        pos[i + 1] += trans.y;
        pos[i + 2] += trans.z;
    }
};


// Get "triangle soup" representation from a geometry.
// [in]: THREE.BufferGeometry
// returns: TypedArray
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


// returns: THREE.BufferGeometry
const generateStockGeom = () => {
    const stockRadius = 7.5;
    const stockHeight = 15;
    const geom = new THREE.CylinderGeometry(stockRadius, stockRadius, stockHeight, 64, 1);
    const transf = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 0, stockHeight / 2),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
        new THREE.Vector3(1, 1, 1));
    geom.applyMatrix4(transf);
    return geom;
};


// [in] VoxelGrid
// [in] label optional string to display on the voxel grid
// returns: THREE.Object3D
const createVgVis = (vg, label = "") => {
    const cubeGeom = new THREE.BoxGeometry(vg.res * 0.9, vg.res * 0.9, vg.res * 0.9);

    const num = vg.count();
    const mesh = new THREE.InstancedMesh(cubeGeom, new THREE.MeshNormalMaterial(), num);
    let instanceIx = 0;
    for (let iz = 0; iz < vg.numZ; iz++) {
        for (let iy = 0; iy < vg.numY; iy++) {
            for (let ix = 0; ix < vg.numX; ix++) {
                const v = vg.get(ix, iy, iz);
                if (v === 0) {
                    continue;
                }

                const mtx = new THREE.Matrix4();
                mtx.compose(
                    new THREE.Vector3(ix, iy, iz).addScalar(0.5).multiplyScalar(vg.res),
                    new THREE.Quaternion(),
                    new THREE.Vector3(1, 1, 1).multiplyScalar(v / 255));
                mesh.setMatrixAt(instanceIx, mtx);
                instanceIx++;
            }
        }
    }

    const meshContainer = new THREE.Object3D();
    meshContainer.add(mesh);
    meshContainer.quaternion.copy(vg.rot);
    meshContainer.position.copy(vg.ofs);

    const axesHelper = new THREE.AxesHelper();
    axesHelper.scale.set(vg.res * vg.numX, vg.res * vg.numY, vg.res * vg.numZ);
    mesh.add(axesHelper);

    if (label !== "") {
        const textGeom = new TextGeometry(label, {
            font,
            size: 2,
            depth: 0.1,
         });
        const textMesh = new THREE.Mesh(textGeom, new THREE.MeshBasicMaterial({ color: "#222222" }));
        meshContainer.add(textMesh);
    }
    
    return meshContainer;
};


// Visualize tool tip path in machine coordinates.
//
// [in] array of THREE.Vector3, path segments
// returns: THREE.Object3D
const createPathVis = (path) => {
    if (path.length === 0) {
        return new THREE.Object3D();
    }

    const vs = [];
    let prevTipPosW = path[0].tipPosW;
    for (let i = 1; i < path.length; i++) {
        const pt = path[i];
        if (pt.type === "remove-work") {
            vs.push(prevTipPosW.x, prevTipPosW.y, prevTipPosW.z);
            vs.push(pt.tipPosW.x, pt.tipPosW.y, pt.tipPosW.z);
        }
        prevTipPosW = pt.tipPosW;
    }

    const pathVis = new THREE.Object3D();

    // add remove path vis
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vs), 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x808080 });
    pathVis.add(new THREE.LineSegments(geom, mat));

    // add refresh path vis
    const sphGeom = new THREE.SphereGeometry(0.15);
    const sphMat = new THREE.MeshBasicMaterial({ color: 0x606060 });
    for (let i = 0; i < path.length; i++) {
        const pt = path[i];
        
        if (pt.type === "move-in") {
            const sph = new THREE.Mesh(sphGeom, sphMat);
            sph.position.copy(pt.tipPosW);
            pathVis.add(sph);
        }
    }

    return pathVis;
};

// Generates a rotation matrix such that Z+ axis will be formed into "z" vector.
// [in] z THREE.Vector3
// returns: THREE.Matrix4
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


// orange-teal-purple color palette for ABC axes.
const axisColorA = new THREE.Color(0xe67e22);
const axisColorB = new THREE.Color(0x1abc9c);
const axisColorC = new THREE.Color(0x9b59b6);

// Creates ring+axis rotational axis visualizer.
// [in] axis THREE.Vector3. rotates around this axis in CCW.
// [in] size number feature size. typically ring radius.
// [in] color THREE.Color
// returns: THREE.Object3D
const createRotationAxisHelper = (axis, size = 1, color = axisColorA) => {
    const NUM_RING_PTS = 32;

    /////
    // contsutuct axis & ring out of line segments

    // Generate as Z+ axis, scale=1 and rotate & re-scale later.
    const buffer = new THREE.BufferGeometry();
    const pts = [];
    // add axis
    pts.push(0, 0, -1);
    pts.push(0, 0, 1);
    // add ring
    for (let i = 0; i < NUM_RING_PTS; i++) {
        const angle0 = 2 * Math.PI * i / NUM_RING_PTS;
        const angle1 = 2 * Math.PI * (i + 1) / NUM_RING_PTS;
        pts.push(Math.cos(angle0), Math.sin(angle0), 0);
        pts.push(Math.cos(angle1), Math.sin(angle1), 0);
    }
    buffer.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    const lineSegs = new THREE.LineSegments(buffer, new THREE.LineBasicMaterial({ color }));

    /////
    // construct direction cones
    const geom = new THREE.ConeGeometry(0.1, 0.2);
    const coneMat = new THREE.MeshBasicMaterial({ color });
    const cone0 = new THREE.Mesh(geom, coneMat);
    const cone1 = new THREE.Mesh(geom, coneMat);
    
    const localHelper = new THREE.Object3D();
    localHelper.add(lineSegs);
    localHelper.add(cone0);
    cone0.position.set(0.99, 0, 0);

    localHelper.add(cone1);
    cone1.scale.set(1, -1, 1);
    cone1.position.set(-0.99, 0, 0);

    ///// 
    // scale & rotate

    // create orthonormal basis for rotation.
    const basisZ = axis.normalize();
    let basisY;
    const b0 = new THREE.Vector3(1, 0, 0);
    const b1 = new THREE.Vector3(0, 1, 0);
    if (b0.clone().cross(basisZ).length() > 0.3) {
        basisY = b0.clone().cross(basisZ).normalize();
    } else {
        basisY = b1.clone().cross(basisZ).normalize();
    }
    const basisX = basisY.clone().cross(basisZ).normalize();

    // init new grid
    const lToWMat3 = new THREE.Matrix3(
        basisX.x, basisY.x, basisZ.x,
        basisX.y, basisY.y, basisZ.y,
        basisX.z, basisY.z, basisZ.z,
    );

    const helper = new THREE.Object3D();
    helper.add(localHelper);

    localHelper.scale.set(size, size, size);
    localHelper.applyMatrix4(new THREE.Matrix4().identity().setFromMatrix3(lToWMat3));
    return helper;
};


// returns: THREE.Object3D
const generateStock = () => {
    const stock = new THREE.Mesh(
        generateStockGeom(),
        new THREE.MeshLambertMaterial({ color: "blue", wireframe: true, transparent: true, opacity: 0.05 }));
    return stock;
};

// Generate tool geom, origin = tool tip. In Z+ direction, there will be tool base marker.
// returns: THREE.Object3D
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


////////////////////////////////////////////////////////////////////////////////
// 3D view

const Model = {
    GT2_PULLEY: "GT2_pulley",
    HELICAL_GEAR: "helical_gear",
    HELICAL_GEAR_STANDING: "helical_gear_standing",
    DICE_TOWER: "dice_tower",
    BENCHY: "benchy_25p",
    BOLT_M3: "M3x10",
};


// Check if a is equal or subset of b.
// [in]: a VoxelGrid
// [in]: b VoxelGrid
// [out]: boolean
const checkIsSubset = (a, b) => {
    const c = b.clone().greaterOrEqual(a);
    return c.count() === c.numX * c.numY * c.numZ;
}

// Apply transformation to AABB, and return the transformed AABB.
// [in] min, max THREE.Vector3 in coordinates A.
// [in] mtx THREE.Matrix4 transforms (A -> B)
// returns: {min: THREE.Vector3, max: THREE.Vector3} in coordinates B.
const transformAABB = (min, max, mtx) => {
    const minB = new THREE.Vector3(1e100, 1e100, 1e100);
    const maxB = new THREE.Vector3(-1e100, -1e100, -1e100);
    for (let i = 0; i < 8; i++) {
        const cubeVertex = new THREE.Vector3(
            (i & 1) ? min.x : max.x,
            (i & 2) ? min.y : max.y,
            (i & 4) ? min.z : max.z,
        ).applyMatrix4(mtx);
        minB.min(cubeVertex);
        maxB.max(cubeVertex);
    }
    return { min: minB, max: maxB };
};


/**
 * Scene is in mm unit. Right-handed, Z+ up. Work-coordinates.
 */
class View3D {
    constructor() {
        this.init();

        // machine geometries
        this.toolDiameter = 1.5;
        this.workOffset = new THREE.Vector3(20, 40, 20); // in machine coords
        this.wireCenter = new THREE.Vector3(30, 15, 30);
        this.stockCenter = new THREE.Vector3(10, 10, 10);

        this.workCoord = new THREE.Object3D();
        this.scene.add(this.workCoord);

        // work-coords
        this.visGroups = {};
        const gridHelperBottom = new THREE.GridHelper(40, 4);
        gridHelperBottom.rotateX(Math.PI / 2);
        this.workCoord.add(gridHelperBottom);

        // machine-coords
        this.tool = generateTool(30, this.toolDiameter);
        this.workCoord.add(this.tool);

        // configuration
        this.ewrMax = 0.3;

        // machine-state setup
        this.toolLength = 25;
        this.workCRot = 0;

        const stock = generateStock();
        this.objStock = stock;
        this.workCoord.add(stock);
        this.model = Model.GT2_PULLEY;
        this.showStockMesh = true;
        this.showTargetMesh = true;

        this.resMm = 0.5;
        this.showWork = true;
        this.showTarget = false;
        this.targetSurf = null;

        this.updateVisTransforms(new THREE.Vector3(-15, -15, 5), new THREE.Vector3(0, 0, 1), this.toolLength);
        this.numSweeps = 0;
        this.showingSweep = 0;
        this.removedVol = 0;
        this.toolIx = 0;
        this.showSweepAccess = false;
        this.showSweepSlice = false;
        this.showSweepRemoval = false;
        this.showPlanPath = true;

        this.initGui();
    }

    updateVisTransforms(tipPos, tipNormal, toolLength) {
        // regen tool; TODO: more efficient way
        this.workCoord.remove(this.tool);
        this.tool = generateTool(toolLength, this.toolDiameter);
        this.workCoord.add(this.tool);

        this.tool.position.copy(tipPos);
        this.tool.setRotationFromMatrix(createRotationWithZ(tipNormal));
    }

    initGui() {
        const gui = new GUI();
        gui.add(this, 'model', Model).onChange((model) => {
            this.updateVis("targ-vg", []);
            this.updateVis("work-vg", []);
            this.updateVis("misc", []);
            this.loadStl(model);
        });
        gui.add(this, "showStockMesh").onChange(v => {
            this.objStock.visible = v;
        }).listen();
        gui.add(this, "showTargetMesh").onChange(v => {
            this.setVisVisibility("target", v);
        }).listen();

        gui.add(this, "resMm", [1e-3, 5e-2, 1e-2, 1e-1, 0.25, 0.5, 1]);
    
        gui.add(this, "initPlan");
        gui.add(this, "genNextSweep");
        gui.add(this, "genNextSweep10");
        gui.add(this, "numSweeps").disable().listen();
        gui.add(this, "removedVol").name("Removed Vol (㎣)").disable().listen();
        gui.add(this, "toolIx").disable().listen();
        // gui.add(this, "showingSweep", 0, this.numSweeps).step(1).listen();
        gui.add(this, "showTarget")
            .onChange(_ => this.setVisVisibility("targ-vg", this.showTarget))
            .listen();
        gui.add(this, "showWork")
            .onChange(_ => this.setVisVisibility("work-vg", this.showWork))
            .listen();
        gui.add(this, "showSweepAccess")
            .onChange(_ => this.setVisVisibility("sweep-access-vg", this.showSweepAccess))
            .listen();
        gui.add(this, "showSweepSlice")
            .onChange(_ => this.setVisVisibility("sweep-slice-vg", this.showSweepSlice))
            .listen();
        gui.add(this, "showSweepRemoval")
            .onChange(_ => this.setVisVisibility("sweep-removal-vg", this.showSweepRemoval))
            .listen();
        gui.add(this, "showPlanPath")
            .onChange(_ => this.setVisVisibility("plan-path-vg", this.showPlanPath))
            .listen();
        
        gui.add(this, "copyGcode");
        gui.add(this, "sendGcodeToSim");
    
        this.loadStl(this.model);
    }

    init() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        const aspect = width / height;
        this.camera = new THREE.OrthographicCamera(-25 * aspect, 25 * aspect, 25, -25, -150, 150);
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

        const light = new THREE.AmbientLight(0x404040); // soft white light
        this.scene.add(light);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(0, 0, 1);
        this.scene.add(directionalLight);

        const hemiLight = new THREE.HemisphereLight(0xffffbb, 0x080820, 1);
        this.scene.add(hemiLight);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);

        this.stats = new Stats();
        container.appendChild(this.stats.dom);

        const guiStatsEl = document.createElement('div');
        guiStatsEl.classList.add('gui-stats');

        window.addEventListener('resize', () => this.onWindowResize());
        Object.assign(window, { scene: this.scene });
    }

    loadStl(fname) {
        const loader = new STLLoader();
        loader.load(
            `models/${fname}.stl`,
            (geometry) => {
                // To avoid parts going out of work by numerical error, slightly offset the part geometry.
                translateGeom(geometry, new THREE.Vector3(0, 0, 0.5));
                this.targetSurf = convGeomToSurf(geometry);

                const material = new THREE.MeshPhysicalMaterial({
                    color: 0xb2ffc8,
                    metalness: 0.1,
                    roughness: 0.8,
                    transparent: true,
                    opacity: 0.8,
                });

                const mesh = new THREE.Mesh(geometry, material)
                this.updateVis("target", [mesh]);
            },
            (xhr) => {
                console.log((xhr.loaded / xhr.total) * 100 + '% loaded')
            },
            (error) => {
                console.log(error);
            }
        );
    }

    initPlan() {
        this.numSweeps = 0;
        this.showingSweep = 0;
        this.removedVol = 0;
        this.toolIx = 0;

        this.stockSurf = convGeomToSurf(generateStockGeom());
        this.workVg = initVGForPoints(this.stockSurf, this.resMm);
        this.targVg = this.workVg.clone();
        diceSurf(this.stockSurf, this.workVg);
        diceSurf(this.targetSurf, this.targVg);
        console.log("stock is large enough", checkIsSubset(this.targVg, this.workVg));

        this.planPath = [];
        this.planner = {
            normalIndex: 0,
        };

        this.updateVis("work-vg", [createVgVis(this.workVg)], this.showWork);
        this.updateVis("targ-vg", [createVgVis(this.targVg)], this.showTarget);
        this.updateVis("plan-path-vg", [createPathVis(this.planPath)], this.showPlanPath);
    }

    genNextSweep10() {
        for (let i = 0; i < 10; i++) {
            const committed = this.genNextSweep();
            if (!committed) {
                break;
            }
        }
    }

    // Pre/post-condition of sweep:
    // * tool is not touching work nor grinder
    // * de-energized

    // returns: true if sweep is committed, false if not
    genNextSweep() {
        if (this.workVg === undefined) {
            this.initPlan();
        }

        const candidateNormals = [
            new THREE.Vector3(1, 0, 0),
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(-1, 0, 0),
            new THREE.Vector3(0, -1, 0),
            new THREE.Vector3(0, 0, 1),
        ];

        // "surface" x canditateNormal
        // compute accessible area from shape x tool base
        //
        // reproject to 0.25mm grid of normal dir as local-Z.
        // compute "access grid"
        //   convolve tool radius in local XY-direction
        //   apply projecting-or in Z- direction
        //   now this grid's empty cells shows accessible locations to start milling from
        // pick the shallowed layer that contains voxels to be removed
        // compute the accesssible voxel in the surface, using zig-zag pattern
        // compute actual path (pre g-code)
        //
        // apply the removal to the work vg (how?)

        const diffVg = this.workVg.clone().sub(this.targVg.clone().saturateFill());
        if (diffVg.count() === 0) {
            console.log("done!");
            return false;
        }

        // Prepare new (rotated) VG for projecting the work.
        // [in] normal THREE.Vector3, world coords. Local Z+ will point normal.
        // returns: VoxelGrid, empty voxel grid
        const initReprojGrid = (normal, res) => {
            const lToWMtx = createRotationWithZ(normal);
            const workMin = this.workVg.ofs.clone();
            const workMax = new THREE.Vector3(this.workVg.numX, this.workVg.numY, this.workVg.numZ).multiplyScalar(this.workVg.res).add(workMin);
            const aabbLoc = transformAABB(workMin, workMax, lToWMtx.clone().invert());
            return initVG(aabbLoc, res, new THREE.Quaternion().setFromRotationMatrix(lToWMtx), false, 5);
        };

        // [in] normal THREE.Vector3, world coords.
        // returns: {
        //   path: array<Vector3>,
        //   deltaWork: VG,
        //   toolLength: number,
        //   toolIx: number,
        //   vis: {target: VG, blocked: VG}
        // } | null (if impossible)
        const genPlanarSweep = (normal) => {
            const accesGridRes = this.resMm;
            
            const sweepBlocked = initReprojGrid(normal, accesGridRes);
            const sweepTarget = sweepBlocked.clone();
            const sweepRemoved = sweepBlocked.clone();
            resampleVG(sweepBlocked, this.workVg);
            sweepBlocked.extendByRadiusXY(this.toolDiameter / 2);
            sweepBlocked.scanZMaxDesc();

            resampleVG(sweepTarget, diffVg);
            const passMaxZ = sweepTarget.findMaxNonZeroZ();

            // prepare 2D-scan at Z= passMaxZ.
            sweepTarget.filterZ(passMaxZ);

            let minScore = 1e100;
            let minPt = null;
            for (let iy = 0; iy < sweepTarget.numY; iy++) {
                for (let ix = 0; ix < sweepTarget.numX; ix++) {
                    const v = sweepTarget.get(ix, iy, passMaxZ);
                    if (v > 0) {
                        const score = ix + iy;
                        if (score < minScore) {
                            minScore = score;
                            minPt = new THREE.Vector2(ix, iy);
                        }
                    }
                }
            }
            // TODO: VERY FRAGILE
            const access = sweepBlocked.get(minPt.x, minPt.y, passMaxZ + 1);  // check previous layer's access
            const accessOk = access === 0;
            if (!accessOk) {
                return null;
            }

            // in planar sweep, tool is eroded from the side.
            const feedCrossSectionArea = this.resMm * this.resMm; // feed width x feed depth; feed must be < toolDiameter/2
            const maxWidthLoss = this.resMm * 0.5;
            const tipRefreshDist = (this.toolDiameter * Math.PI * maxWidthLoss * this.resMm / this.ewrMax) / feedCrossSectionArea;
            
            // generate zig-zag
            let isFirstInLine = true;
            let dirR = true; // true: right, false: left
            let currIx = minPt.x;
            let currIy = minPt.y;
            let distSinceRefresh = 0;
            let toolLength = this.toolLength;
            let toolIx = this.toolIx;
            let prevPtTipPos = null;
            const sweepPath = [];

            const withAxisValue = (pt) => {
                const isPosW = pt.tipPosW !== undefined;
                const ikResult = this.solveIk(isPosW ? pt.tipPosW : pt.tipPosM, pt.tipNormalW, toolLength, isPosW);
                return {
                    ...pt,
                    tipPosM: ikResult.tipPosM,
                    tipPosW: ikResult.tipPosW,
                    axisValues: ikResult.vals,
                };
            };

            while (true) {
                sweepRemoved.set(currIx, currIy, passMaxZ, 255);
                const tipPos = sweepTarget.centerOf(currIx, currIy, passMaxZ);
                distSinceRefresh += this.resMm;

                if (distSinceRefresh > tipRefreshDist) {
                    // TODO: gen disengage path

                    // gen refresh
                    const motionBeginOffset = new THREE.Vector3(-5, 0, 0);
                    const motionEndOffset = new THREE.Vector3(5, 0, 0);

                    const lengthAfterRefresh = toolLength - this.resMm; // resMm == feed depth
                    if (lengthAfterRefresh < 5) {
                        // cannot refresh; get new tool
                        toolIx++;
                        toolLength = 25;
                    } else {
                        // refresh by grinding

                        // TODO: proper tool length
                        sweepPath.push(withAxisValue({
                            sweep: this.numSweeps,
                            group: `refresh`,
                            type: "move-out",
                            tipPosM: this.wireCenter.clone().add(motionBeginOffset),
                            tipNormalW: new THREE.Vector3(0, 0, 1),
                        }));

                        sweepPath.push(withAxisValue({
                            sweep: this.numSweeps,
                            group: `refresh`,
                            type: "remove-tool",
                            toolRotDelta: Math.PI * 2,
                            grindDelta: 10,
                            tipPosM: this.wireCenter.clone().add(motionEndOffset),
                            tipNormalW: new THREE.Vector3(0, 0, 1),
                        }));

                        toolLength = lengthAfterRefresh;
                    }

                    // TODO: gen proper return path
                    sweepPath.push(withAxisValue({
                        sweep: this.numSweeps,
                        group: `return`,
                        type: "move-in",
                        tipNormalW: normal,
                        tipPosW: tipPos,
                    }));

                    distSinceRefresh = 0;
                }

                const nextIx = currIx + (dirR ? 1 : -1);
                const nextNeeded = sweepTarget.get(nextIx, currIy, passMaxZ) > 0;
                const upNeeded = sweepTarget.get(currIx, currIy + 1, passMaxZ) > 0;
                const nextAccess = sweepBlocked.get(nextIx, currIy, passMaxZ + 1) === 0;
                const upAccess = sweepBlocked.get(currIx, currIy + 1, passMaxZ + 1) === 0;
                const upOk = upNeeded && upAccess;
                const nextOk = nextNeeded && nextAccess;

                const rotPerDist = Math.PI * 2 / 1.0;
                let toolRotDelta = 0;
                if (prevPtTipPos !== null) {
                    const d = tipPos.distanceTo(prevPtTipPos);
                    toolRotDelta = d * rotPerDist;
                }

                const pathPt = withAxisValue({
                    sweep: this.numSweeps,
                    group: `sweep-${this.numSweeps}`,
                    type: "remove-work",
                    tipNormalW: normal,
                    tipPosW: tipPos,
                    toolRotDelta: toolRotDelta,
                });

                if (isFirstInLine) {
                    sweepPath.push(pathPt);
                    prevPtTipPos = tipPos;

                    isFirstInLine = false;
                }

                if (!nextOk && !upOk) {
                    sweepPath.push(pathPt);
                    prevPtTipPos = tipPos;

                    break;
                }
                if (nextOk) {
                    // don't write to path here
                    currIx = nextIx;
                } else {
                    sweepPath.push(pathPt);
                    prevPtTipPos = tipPos;

                    isFirstInLine = true;
                    dirR = !dirR;
                    currIy++;
                }
            }

            const deltaWork = this.workVg.clone();
            deltaWork.fill(0);
            sweepRemoved.extendByRadiusXY(this.toolDiameter / 2);
            resampleVG(deltaWork, sweepRemoved);

            return {
                path: sweepPath,
                deltaWork: deltaWork,
                toolIx: toolIx,
                toolLength: toolLength,
                vis: {
                    target: sweepTarget,
                    removed: sweepRemoved,
                }
            };
        };

        let sweep = null;
        for (let i = 0; i < candidateNormals.length; i++) {
            sweep = genPlanarSweep(candidateNormals[this.planner.normalIndex]);
            if (sweep) {
                break;
            }
            this.planner.normalIndex = (this.planner.normalIndex + 1) % candidateNormals.length;
        }
        if (sweep === null) {
            console.log("possible sweep exhausted");
            return false;
        }

        console.log(`commiting sweep ${this.numSweeps}`, sweep);

        this.planPath.push(...sweep.path);
        this.toolIx = sweep.toolIx;
        this.toolLength = sweep.toolLength;
        const volBeforeSweep = this.workVg.volume();
        this.workVg.sub(sweep.deltaWork);
        const volAfterSweep = this.workVg.volume();
        this.removedVol += volBeforeSweep - volAfterSweep;
        this.numSweeps++;
        this.showingSweep++;

        this.updateVis("sweep-slice-vg", [createVgVis(sweep.vis.target, "sweep-slice")], this.showSweepSlice);
        this.updateVis("sweep-removal-vg", [createVgVis(sweep.vis.removed, "sweep-removal")], this.showSweepRemoval);

        this.updateVis("plan-path-vg", [createPathVis(this.planPath)], this.showPlanPath, false);
        this.updateVis("work-vg", [createVgVis(this.workVg, "work-vg")], this.showWork);

        const lastPt = this.planPath[this.planPath.length - 1];
        this.updateVisTransforms(lastPt.tipPosW, lastPt.tipNormalW, this.toolLength);

        return true;
    }

    // Computes tool base & work table pos from tip target.
    //
    // [in] tipPos tip position in work coordinates
    // [in] tipNormalW tip normal in machine coordinates (+ is pointing towards base = work surface normal)
    // [in] isPosW true: tipPos is in work coordinates, false: tipPos is in machine coordinates
    // [out] {vals: {x, y, z, b, c} machine instructions for moving work table & tool base, tipPosM: THREE.Vector3 tip position in machine coordinates}
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

    copyGcode() {
        const prog = this.generateGcode();
        navigator.clipboard.writeText(prog);
    }

    sendGcodeToSim() {
        const prog = this.generateGcode();
        new BroadcastChannel("gcode").postMessage(prog);
    }

    generateGcode() {
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

        for (let i = 0; i < this.planPath.length; i++) {
            const pt = this.planPath[i];
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
            } else if (pt.type === "move-out" || pt.type === "move-in") {
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

    updateVis(group, vs, visible = true) {
        const parent = this.workCoord;
        if (this.visGroups[group]) {
            this.visGroups[group].forEach(v => parent.remove(v));
        }
        vs.forEach(v => {
            parent.add(v);
            v.visible = visible;
        });
        this.visGroups[group] = vs;
    }

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
    }

    animate() {
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
        this.stats.update();
    }
}


////////////////////////////////////////////////////////////////////////////////
// entry point


const loadFont = async () => {
    return new Promise((resolve) => {
        fontLoader.load("./Source Sans 3_Regular.json", (f) => {
            font = f;
            resolve();
        });
    });
};

(async () => {
    await loadFont();
    const view = new View3D();
})();
