// Cell (i, j) covers [i, i+1] x [j, j+1] in world coordinate space.
// Cell state
const C_EMPTY = 0;
const C_PARTIAL = 1;
const C_FULL = 2;

// rendering configs
const GRID_SIZE = 100;   // 100x100
const CELL_PIXELS = 5;   // each cell is 5x5 on canvas


const createEmptyGrid = () => {
    // 2D array [GRID_SIZE x GRID_SIZE]
    let arr = new Array(GRID_SIZE);
    for (let i = 0; i < GRID_SIZE; i++) {
        arr[i] = new Array(GRID_SIZE).fill(C_EMPTY);
    }
    return arr;
}

/**
 * Draws the given grid on the canvas
 */
const drawGrid = (grid) => {
    // Scale each cell to 5x5 pixels
    // and color based on state
    for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
            let state = grid[y][x];
            ctx.fillStyle = getColorForState(state);
            ctx.fillRect(x * CELL_PIXELS, y * CELL_PIXELS, CELL_PIXELS, CELL_PIXELS);
        }
    }

    // Draw grid lines
    ctx.strokeStyle = "lightgray";
    ctx.strokeWidth = 0.5;
    for (let y = 0; y < GRID_SIZE; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * CELL_PIXELS);
        ctx.lineTo(GRID_SIZE * CELL_PIXELS, y * CELL_PIXELS);
        ctx.stroke();
    }
    for (let x = 0; x < GRID_SIZE; x++) {
        ctx.beginPath();
        ctx.moveTo(x * CELL_PIXELS, 0);
        ctx.lineTo(x * CELL_PIXELS, GRID_SIZE * CELL_PIXELS);
        ctx.stroke();
    }
}


// [in] sq: {x, y, s} occupies square centered at (x, y), side length=s
// [in] circle: {x, y, r} occupies circle with center=(x, y), radius=r
// [out] true if square and circle intersect
const intersectSquareCircle = (sq, circle) => {
    // Half the side length
    const half = sq.s / 2;

    // Clamp a value v between min & max
    const clamp = (v, mn, mx) => Math.max(mn, Math.min(v, mx));

    // Find the closest point on the square (in x & y) to the circle center
    const closestX = clamp(circle.x, sq.x - half, sq.x + half);
    const closestY = clamp(circle.y, sq.y - half, sq.y + half);

    // Distance from that closest point to the circle center
    const dx = circle.x - closestX;
    const dy = circle.y - closestY;

    // They intersect if that distance <= circle's radius
    return (dx * dx + dy * dy) <= (circle.r * circle.r);
};

// [in] sq: {x, y} occupies square centered at (x, y), side length=sz
// [in] box: {x, y, angle} occupies square centered at (x, y), side length=sz, rotated by angle (radians)
// [out] true if square and box intersect
const intersectSquareBox = (sq, box, sz) => {
    // 1) Build corners for the axis-aligned square (sq).
    //    Each corner is (cx ± half, cy ± half).
    const getSquareCorners = (cx, cy, side) => {
        const h = side / 2;
        return [
            [cx - h, cy - h],
            [cx + h, cy - h],
            [cx + h, cy + h],
            [cx - h, cy + h],
        ];
    };

    // 2) Build corners for the rotated square (box).
    //    We'll rotate each corner around (box.x, box.y) by box.angle.
    const rotatePoint = (px, py, cx, cy, angle) => {
        const dx = px - cx, dy = py - cy;
        const ca = Math.cos(angle), sa = Math.sin(angle);
        return [
            cx + dx * ca - dy * sa,
            cy + dx * sa + dy * ca
        ];
    };
    const getBoxCorners = (cx, cy, side, angle) => {
        const corners = getSquareCorners(cx, cy, side);
        return corners.map(([px, py]) => rotatePoint(px, py, cx, cy, angle));
    };

    // 3) Helper to project a polygon's corners onto an axis and get [min, max] range.
    const project = (corners, ax, ay) => {
        let mn = Infinity, mx = -Infinity;
        for (const [x, y] of corners) {
            const dot = x * ax + y * ay;
            mn = Math.min(mn, dot);
            mx = Math.max(mx, dot);
        }
        return [mn, mx];
    };

    // 4) Check 1D overlap for two intervals.
    const overlap = (rangeA, rangeB) => !(rangeA[1] < rangeB[0] || rangeB[1] < rangeA[0]);

    // Get corners for both squares
    const cornersA = getSquareCorners(sq.x, sq.y, sz);           // axis-aligned
    const cornersB = getBoxCorners(box.x, box.y, sz, box.angle); // rotated

    // We'll check 4 axes:
    //   - 2 from the axis-aligned square => (1,0) & (0,1)
    //   - 2 from the rotated box         => (cosA, sinA) & (-sinA, cosA)
    const cosA = Math.cos(box.angle), sinA = Math.sin(box.angle);
    const axes = [
        [1, 0],
        [0, 1],
        [cosA, sinA],
        [-sinA, cosA]
    ];

    // 5) Run the Separating Axis Test (SAT). If any axis doesn't overlap -> no intersection.
    for (const [ax, ay] of axes) {
        const rangeA = project(cornersA, ax, ay);
        const rangeB = project(cornersB, ax, ay);
        if (!overlap(rangeA, rangeB)) return false;
    }
    return true; // All axes overlap => squares intersect
};



/**
 * Returns a color to visualize the 3 states:
 * 0=Empty -> white, 1=Partial -> orange, 2=Full -> blue
 */
const getColorForState = (state) => ["white", "orange", "blue"][state];

/**
 * Clears the canvas
 */
const clearCanvas = () => ctx.clearRect(0, 0, canvas.width, canvas.height);

// ----- SHAPE INITIALIZATION -----

/**
 * Resets the oldGrid to a box or circle. 
 * Then draws it immediately.
 */
const resetGrid = (shapeType) => {
    oldGrid = createEmptyGrid();

    if (shapeType === "box") {
        fillBox(oldGrid, 25, 25, 50, 50);  // e.g. a 50x50 box near the center
    } else {
        fillCircle(oldGrid, 50, 50, 25);   // center=(50,50), radius=25
    }

    clearCanvas();
    drawGrid(oldGrid);
}

/**
 * Fill a rectangular region in the grid with state=1 (full).
 * (x,y) is top-left corner, w,h are width/height
 */
const fillBox = (grid, x, y, w, h) => {
    for (let j = y; j < y + h; j++) {
        for (let i = x; i < x + w; i++) {
            if (intersectSquareBox({ x: i + 0.5, y: j + 0.5, s: 1 }, { x: x + 0.5, y: y + 0.5, angle: 0 }, w)) {
                grid[j][i] = C_FULL;
            }
        }
    }
}

/**
 * Fill a circle region in the grid with state=1 (full).
 * center=(cx,cy), radius=r
 */
const fillCircle = (grid, cx, cy, r) => {
    for (let j = 0; j < GRID_SIZE; j++) {
        for (let i = 0; i < GRID_SIZE; i++) {
            if (intersectSquareCircle({ x: i + 0.5, y: j + 0.5, s: 1 }, { x: cx + 0.5, y: cy + 0.5, r: r })) {
                grid[j][i] = C_FULL;
            }
        }
    }
}


// ----- RESAMPLING: ROTATION & TRANSLATION -----

/**
 * Called when user clicks "Resample".
 * We'll read angle, tx, ty from inputs,
 * apply transform to oldGrid -> newGrid,
 * then show newGrid, 
 * and finally copy newGrid into oldGrid for next iteration.
 */
const resample = () => {
    // Read user inputs
    let angleDeg = parseFloat(document.getElementById("angleInput").value) || 0;
    let tx = parseFloat(document.getElementById("txInput").value) || 0;
    let ty = parseFloat(document.getElementById("tyInput").value) || 0;

    // Convert angle to radians
    let angleRad = (Math.PI / 180) * angleDeg;

    // Prepare newGrid as empty
    newGrid = createEmptyGrid();

    // For each cell in the new grid, check how it maps back to oldGrid
    // We'll define each cell in newGrid as corners:
    //  (x, y) -> (x+1, y+1) in "new" space.
    // We'll invert transform those corners back to old space and see how many corners are inside the old shape.
    for (let newY = 0; newY < GRID_SIZE; newY++) {
        for (let newX = 0; newX < GRID_SIZE; newX++) {
            const newCenterX = newX + 0.5;
            const newCenterY = newY + 0.5;

            // Inverse transform: 
            // newCoord = R(angle)*oldCoord + T => oldCoord = R(-angle)*(newCoord - T)
            let oldCoord = inverseTransform(newCenterX, newCenterY, angleRad, tx, ty);

            const oldIxX = Math.floor(oldCoord[0]);
            const oldIyY = Math.floor(oldCoord[1]);

            const res = [];
            for (let x = oldIxX - 1; x <= oldIxX + 1; x++) {
                if (x < 0 || x >= GRID_SIZE) continue;

                for (let y = oldIyY - 1; y <= oldIyY + 1; y++) {
                    if (y < 0 || y >= GRID_SIZE) continue;
                    const isect = intersectSquareBox({x: x + 0.5, y: y + 0.5}, {x: oldCoord[0], y: oldCoord[1], angle: -angleRad}, 1);
                    if (isect) {
                        res.push(oldGrid[y][x]);
                    }
                }
            }

            if (res.length === 0) {
                newGrid[newY][newX] = C_EMPTY;
            } else if (res.every(x => x === C_FULL)) {
                newGrid[newY][newX] = C_FULL;
            } else if (res.every(x => x === C_EMPTY)) {
                newGrid[newY][newX] = C_EMPTY;
            } else {
                newGrid[newY][newX] = C_PARTIAL;
            }
        }
    }

    // Show new grid
    clearCanvas();
    drawGrid(newGrid);

    // Move newGrid => oldGrid so we can apply multiple transformations
    oldGrid = newGrid;
}

/**
 * Inverse transform from new space to old space.
 * We have:
 *   oldPos = rotate(-angle)( newPos - (tx, ty) )
 *
 * Return [oldX, oldY].
 */
const inverseTransform = (newX, newY, angleRad, tx, ty) => {
    // Translate first (inverse is subtracting tx, ty)
    let translatedX = newX - tx;
    let translatedY = newY - ty;

    // Then rotate by -angle (clockwise).
    let cosA = Math.cos(-angleRad);
    let sinA = Math.sin(-angleRad);

    // 2D rotation:
    // oldX = cos(-θ)*translatedX - sin(-θ)*translatedY
    // oldY = sin(-θ)*translatedX + cos(-θ)*translatedY
    // But cos(-θ)=cos(θ), sin(-θ)=-sin(θ).
    // Let's just use cosA, sinA directly:
    let oldX = translatedX * cosA - translatedY * sinA;
    let oldY = translatedX * sinA + translatedY * cosA;

    return [oldX, oldY];
}

/**
 * Check if a fractional (oldX, oldY) is inside the old shape
 * based purely on the discrete oldGrid.
 * We say "inside" if oldX,oldY is within [0,GRID_SIZE) 
 * and oldGrid[y][x] == 1 (full).
 *
 * NOTE: This is a naive check. We only do a direct index check 
 *       (round down).
 */
const isInsideOldGrid = (oldX, oldY) => {
    // We'll do a simple boundary check
    // Then pick the integer cell index floor(oldX), floor(oldY).
    let ix = Math.floor(oldX);
    let iy = Math.floor(oldY);

    if (ix < 0 || ix >= GRID_SIZE || iy < 0 || iy >= GRID_SIZE) {
        // outside the old grid entirely => definitely not inside
        return false;
    }

    // If oldGrid[iy][ix] is C_FULL, we say it's inside.
    // If it's C_EMPTY or C_PARTIAL, we treat it as not fully inside 
    // (this is simplistic).
    return (oldGrid[iy][ix] === C_FULL);
}


// ----- INITIALIZATION -----

const canvas = document.getElementById("gridCanvas");
const ctx = canvas.getContext("2d");

// We'll store the old and new grids here.
let oldGrid = createEmptyGrid();
let newGrid = createEmptyGrid();


resetGrid("box"); // start with a box by default
drawGrid(oldGrid);
