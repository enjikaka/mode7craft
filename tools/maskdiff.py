# usage: maskdiff.py old.png new.png new_water_magenta.png -> pixels that changed outside the water mask
# (mask = pixels where a build whose water() returns magenta differs from the normal build)
import sys
from PIL import Image, ImageChops
import numpy as np
a,b,m=[np.asarray(Image.open(f).convert('RGB')).astype(int) for f in sys.argv[1:4]]
d=(np.abs(a-b).sum(2)>0); w=(np.abs(b-m).sum(2)>0)
print(f"diff={d.sum()} water={w.sum()} diff_outside_water={(d&~w).sum()}")
