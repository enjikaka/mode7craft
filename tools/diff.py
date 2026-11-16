# pixel diff of two screenshots: prints differing pixel count + bbox
import sys
from PIL import Image, ImageChops
a = Image.open(sys.argv[1]).convert('RGB'); b = Image.open(sys.argv[2]).convert('RGB')
d = ImageChops.difference(a, b); bb = d.getbbox()
n = sum(1 for p in d.get_flattened_data() if p != (0, 0, 0)) if bb else 0
print(sys.argv[1], 'vs', sys.argv[2], 'IDENTICAL' if not bb else f'{n} px differ, bbox {bb}')
