"""Build generate_image_batch requests (one theme = one batch of 12) from briefs.json."""
import json, sys
SUFFIX = (" Full body, head to feet fully visible, standing, both feet on the ground, body turned three-quarter toward the front,"
 " arms visible. Character centred on a 2:3 portrait canvas with about 8% empty margin around, feet on the bottom edge."
 " Stylized semi-realistic digital painting, warm and friendly, in the spirit of high-end animated feature film concept art, not photoreal."
 " Flat, even soft front lighting; NO rim light, NO glow, NO halo, NO backlight, NO ground shadow, clean silhouette edge."
 " Fully transparent background, no text, no logo, no scenery. Original invented character, not resembling any real person"
 " or any existing fictional character.")
FOLDER = "ec6df37d-8282-4cd0-a484-9da87063105a"
d = json.load(open("briefs.json"))
theme = sys.argv[1]
t = next(x for x in d["themes"] if x["id"] == theme)
reqs = [{"index": i, "params": {"model": "gpt_image_2_5", "resolution": "4k", "quality": "high", "aspect_ratio": "2:3",
         "background": "transparent", "folder_id": FOLDER,
         "prompt": f"Original character for a desktop app {'avatar' if theme == 'pets' else 'coworker avatar'}, theme: {t['name']}. {c['brief']}{SUFFIX}"}}
        for i, c in enumerate(t["characters"])]
print(json.dumps(reqs))
