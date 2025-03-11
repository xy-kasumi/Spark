# SPDX-License-Identifier: CERN-OHL-S-2.0
import cadquery as cq
import frame_channel as fc
import frame_joint as fj
import frame_foot as ff
import cq_electronics.din_rail as din

channel_sz = 20
frame_width = 300 # also top/bottom channel length
frame_hlen = 300 # length of left/right channels

pcb_pulser = cq.importers.importStep("./PULSER-R2.step")
pcb_core = cq.importers.importStep("./CORE-R0.step")
inlet = cq.importers.importStep("./inlet-15CBE1.step")

psu_main = cq.Workplane("XY").box(225, 124, 41).faces(">Z").workplane().center(-225/2,0).rect(32, 120).cutBlind(-28)
psu_small = cq.Workplane("XY").box(79 + 10, 51, 28.5).faces(">Z").workplane().center(-89/2,-51/2).rect(20, 20).cutThruAll()

cover = cq.Workplane("XZ").box(300, 340, 5)


corner = (
    cq.Workplane("XY")
    .rect(5, 5)
    .extrude(4)
)

col_frame = cq.Color("gray")

bench = (
    cq.Assembly()
    .add(fc.make_channel(300), name="left", loc=cq.Location((channel_sz / 2, 0, channel_sz / 2)))
    .add(fc.make_channel(300), name="right", loc=cq.Location((frame_width - channel_sz / 2, 0, channel_sz / 2)))
    .add(fc.make_channel(frame_width ), name="bottom", loc=cq.Location((0, 0, 0), (0, 1, 0), 90))
    .add(fc.make_channel(frame_width ), name="top", loc=cq.Location((0, 0, 320), (0, 1, 0), 90))
    .add(din.TopHat(300).cq_object, name="din1")
    .add(din.TopHat(300).cq_object, name="din2")
    .add(din.TopHat(300).cq_object, name="din3")
    .add(fj.make_joint(), name="j_botleft", loc=cq.Location((channel_sz, channel_sz / 2, channel_sz / 2), (1, 0, 0), 90))
    .add(fj.make_joint(), name="j_botright", loc=cq.Location((frame_width - channel_sz, channel_sz / 2, channel_sz / 2), (90, -90, 0)))
    .add(fj.make_joint(), name="j_topleft", loc=cq.Location((channel_sz, -channel_sz / 2, frame_hlen + channel_sz / 2), (-90, 0, 0)))
    .add(fj.make_joint(), name="j_topright", loc=cq.Location((frame_width - channel_sz, -channel_sz / 2, frame_hlen + channel_sz / 2), (-90, 90, 0)))
    .add(psu_main, name="psu_main_36v", loc=cq.Location((160, 40, 90), (-90, 0, 0)))
    .add(psu_small, name="psu_main_12v", loc=cq.Location((100, 40, 230), (-90, 90, 0)))
    .add(psu_small, name="psu_main_24v", loc=cq.Location((180, 40, 230), (-90, 90, 0)))
    .add(pcb_pulser, loc=cq.Location((200, -25, 150), (90, -90, 0)))
    .add(pcb_core, loc=cq.Location((80, -25, 150), (90, -90, 0)))
    .add(inlet, loc=cq.Location((10, 40, 230), (90, 0, -90)))
    .add(cover, loc=cq.Location((150, 72.5, 160)))
    .add(ff.make_foot(), loc=cq.Location((frame_width, 77, -channel_sz/2), (0, 0, 180)))
)

# Constrain face_end to "meet" with face_plane
# that is
# center of face_end lies on face_plane
# face_end & face_plane is parallel
def meets(face_end, face_plane):
    bench.constrain(face_end, face_plane, "PointInPlane")
    bench.constrain(face_end, face_plane, "Axis")

plane_floor = "bottom@faces@>X"
plane_yplus = "bottom@faces@>Y"
plane_yminus = "bottom@faces@<Y"

din1_plane = "din1@faces@<Z"
din1_dir = "din1@edges@|X"
din1_edge = "din1@faces@<X"

din2_plane = "din2@faces@<Z"
din2_dir = "din2@edges@|X"
din2_edge = "din2@faces@<X"

din3_plane = "din3@faces@<Z"
din3_dir = "din3@edges@|X"
din3_edge = "din3@faces@<X"

(
     bench
     .constrain("bottom", "Fixed")
     .constrain("left", "Fixed")
     .constrain("right", "Fixed")
)

# din1 / din2: PSUs
meets(din1_plane, plane_yplus)
bench.constrain(din1_dir, "FixedAxis", (1, 0, 0))
bench.constrain(din1_plane, plane_floor, "PointInPlane", param=-120+20)
bench.constrain(din1_edge, "bottom@faces@<Z", "PointInPlane")

meets(din2_plane, plane_yplus)
bench.constrain(din2_dir, "FixedAxis", (1, 0, 0))
bench.constrain(din2_plane, plane_floor, "PointInPlane", param=-220-20)
bench.constrain(din2_edge, "bottom@faces@<Z", "PointInPlane")

# din3: PCBs (CORE & PULSER)
meets(din3_plane, plane_yminus)
bench.constrain(din3_dir, "FixedAxis", (1, 0, 0))
bench.constrain(din3_plane, plane_floor, "PointInPlane", param=-150)
bench.constrain(din3_edge, "bottom@faces@<Z", "PointInPlane")



bench.solve()

show_object(bench)