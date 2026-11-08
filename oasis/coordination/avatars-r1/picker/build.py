import json
B=json.load(open('briefs.json')); R=json.load(open('results.json'))
CODE={'arcade':'ARC','space':'SPC','hitchhiker':'HIK','desert':'DSR','robot':'RBT','pets':'PET','fantasy':'FAN','office':'OFF'}
data=[]
for t in B['themes']:
    chars=[]
    for i,c in enumerate(t['characters']):
        r=R[t['id']][str(i)]
        chars.append({'id':c['id'],'code':f"{CODE[t['id']]} {i+1:02d}",'name':c['name'],'brief':c['brief'],'img':f"img/{c['id']}.webp",'master':r['url']})
    data.append({'id':t['id'],'name':t['name'],'characters':chars})
html=open('picker/template.html').read().replace('/*DATA*/[]',json.dumps(data,ensure_ascii=False))
open('picker/index.html','w').write(html)
json.dump({f"img/{c['id']}.webp":f"img/{c['id']}.webp" for t in data for c in t['characters']},open('picker/files.json','w'))
print(len(html)//1024,'KB')
