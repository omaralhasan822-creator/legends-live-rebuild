from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path('/mnt/data/legends_live')
html=(ROOT/'public/index.html').read_text()
css=(ROOT/'public/style.css').read_text()
js=(ROOT/'public/app.js').read_text()
html=html.replace('<link rel="stylesheet" href="/style.css" />',f'<style>{css}</style>')
html=html.replace('<script src="/app.js" defer></script>','')
html=html.replace('<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800;900&family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">','')
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
    c=b.new_context(viewport={'width':1440,'height':900},device_scale_factor=1)
    page=c.new_page()
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.set_content(html)
    page.add_script_tag(content=js)
    page.screenshot(path=str(ROOT/'preview_entry.png'),full_page=True)
    stage_js = '''
    selfId='abc';
    room={code:'ABC234',host:'abc',phase:'choice',active:'abc',judge:null,category:null,ruling:'',round:3,
      players:[{id:'abc',name:'فارس الليل',avatar:'🦊',score:30,online:true,mic:true},
      {id:'xyz',name:'ملكة النجوم',avatar:'🦄',score:20,online:true,mic:false},
      {id:'pqr',name:'الأسطورة',avatar:'🐲',score:10,online:true,mic:true}],chat:[
      {id:'1',from:'xyz',name:'ملكة النجوم',avatar:'🦄',text:'يا جماعة مستعدين؟ 🔥',time:1700000000},
      {id:'2',from:'abc',name:'فارس الليل',avatar:'🦊',text:'أكيد، هلأ منشوف 😎',time:1700000010},
      {id:'3',from:'pqr',name:'الأسطورة',avatar:'🐲',text:'اختار الجرأة! 😂',time:1700000020}]};
    document.getElementById('entry').classList.add('hidden');document.getElementById('game').classList.remove('hidden');
    previousPhase='';previousRound=-1;render();
    '''
    page.evaluate(stage_js)
    page.wait_for_timeout(1400)
    page.screenshot(path=str(ROOT/'preview_choice.png'),full_page=True)
    page.evaluate("room.phase='write';room.category='truth';room.judge='abc';previousPhase='';render();")
    page.wait_for_timeout(700)
    page.screenshot(path=str(ROOT/'preview_judge.png'),full_page=True)
    page.evaluate("room.phase='reveal';room.ruling='ما أكثر شيء تحبه في المدرسة؟';previousPhase='';render();")
    page.wait_for_timeout(2300)
    page.screenshot(path=str(ROOT/'preview_reveal.png'),full_page=True)
    print('desktop errors:',errors)
    m=b.new_context(viewport={'width':430,'height':900},device_scale_factor=1)
    mobile=m.new_page()
    mobile.set_content(html);mobile.add_script_tag(content=js)
    mobile.screenshot(path=str(ROOT/'preview_mobile_entry.png'),full_page=True)
    mobile.evaluate(stage_js)
    mobile.wait_for_timeout(1400)
    mobile.screenshot(path=str(ROOT/'preview_mobile_choice.png'),full_page=True)
    print('mobile no horizontal overflow:',mobile.evaluate('document.documentElement.scrollWidth <= innerWidth'))
    mobile.locator('#chatToggle').click()
    mobile.wait_for_timeout(350)
    mobile.screenshot(path=str(ROOT/'preview_mobile_chat.png'),full_page=True)
    assert not errors
    b.close()
