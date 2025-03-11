import cadquery as cq
import frame_channel as fc
import cq_electronics.din_rail as din

channel_sz = 20
frame_width = 300 # also top/bottom channel length


result = (
    cq.Assembly()
    .add(fc.make_channel(300), name="left", loc=cq.Location((channel_sz / 2, 0, channel_sz / 2)))
    .add(fc.make_channel(300), name="right", loc=cq.Location((frame_width  - channel_sz / 2, 0, channel_sz / 2)))
    .add(fc.make_channel(frame_width ), name="bottom", loc=cq.Location((0, 0, 0), (0, 1, 0), 90))
    .add(fc.make_channel(frame_width ), name="top", loc=cq.Location((0, 0, 320), (0, 1, 0), 90))
    .add(din.TopHat(300).cq_object, name="din1")
    .add(din.TopHat(300).cq_object, name="din2")
)

# Constrain face_end to "meet" with face_plane
# that is
# center of face_end lies on face_plane
# face_end & face_plane is parallel
def meets(face_end, face_plane):
    result.constrain(face_end, face_plane, "PointInPlane")
    result.constrain(face_end, face_plane, "Axis")

plane_floor = "bottom@faces@>X"
plane_yplus = "bottom@faces@>Y"
plane_yminus = "bottom@faces@<Y"

din1_plane = "din1@faces@<Z"
din1_dir = "din1@edges@|X"
din1_edge = "din1@faces@<X"

din2_plane = "din2@faces@<Z"
din2_dir = "din2@edges@|X"
din2_edge = "din2@faces@<X"

(
     result
     .constrain("bottom", "Fixed")
     .constrain("left", "Fixed")
     .constrain("right", "Fixed")
)

meets(din1_plane, plane_yplus)
result.constrain(din1_dir, "FixedAxis", (1, 0, 0))
result.constrain(din1_plane, plane_floor, "PointInPlane", param=-120+20)
result.constrain(din1_edge, "bottom@faces@<Z", "PointInPlane")

meets(din2_plane, plane_yplus)
result.constrain(din2_dir, "FixedAxis", (1, 0, 0))
result.constrain(din2_plane, plane_floor, "PointInPlane", param=-220-20)
result.constrain(din2_edge, "bottom@faces@<Z", "PointInPlane")


result.solve()

show_object(result)