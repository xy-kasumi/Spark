# SPDX-License-Identifier: CERN-OHL-S-2.0
import cadquery as cq
import frame_joint
import frame_foot
import din_clip
import inlet_adapter

frame_joint.make_joint().export("build/frame_joint.stl")
frame_foot.make_foot().export("build/frame_foot.stl")

din_clip.make_din_clip_holes([-5, 45], 4.4, 45, 50).export("build/din_clip_lrs600.stl")
din_clip.make_din_clip_holes([-10, 45], 3.3, 37, 50).export("build/din_clip_ls25.stl")
din_clip.make_din_clip_inserts([-35, 70], 5.1, 40, 75).export("build/din_clip_core.stl")
din_clip.make_din_clip_inserts([-70, 80], 5.1, 75, 85).export("build/din_clip_octopuspro.stl")
din_clip.make_din_clip_inserts([-60, 80], 5.1, 65, 85).export("build/din_clip_pulser.stl")

inlet_adapter.make_inlet_adapter().export("build/inlet_adapter.stl")

