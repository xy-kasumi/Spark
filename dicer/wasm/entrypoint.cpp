// All coordinates are right-handed.

typedef struct {
    float x;
    float y;
    float z;
} vector3;

typedef struct {
    int vs[3];
} tri_ix;

// Triangle mesh with no holes or self-intersections.
// Vertices in a triangle are in CCW order.
typedef struct {
    int num_vertices;
    vector3* vertices;

    int num_triangles;
    tri_ix* triangles;
} triangle_mesh;

// Project 3D mesh onto a plane defined by view_dir_z and origin.
// view_x, view_y, view_dir_z are orthogonal basis. (i.e. view_x x view_y = view_dir_z, view_y x view_dir_z = view_x, view_dir_z x view_x = view_y).
// Returned mesh is a 2.5D representation that represents the "height map" seen from thew view_dir_z+ direction.
// Meaning, it only contains triangles that are visible from the view_dir_z+ direction, and intersecting contours are properly splitted.
//
// caller must free the returned mesh
// view_dir: normalized direction vector
triangle_mesh* project_mesh(
    const triangle_mesh* mesh,
    const vector3* origin,
    const vector3* view_x,
    const vector3* view_y,
    const vector3* view_dir_z,
) {
    // TODO: implement
}
