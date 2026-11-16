"""Integration test: run server first with uvicorn server:app --port 8765."""
import asyncio
import json
import websockets

URL='ws://127.0.0.1:8765/ws'
async def recv_type(ws,typ, limit=10):
    for _ in range(limit):
        data=json.loads(await asyncio.wait_for(ws.recv(),timeout=5))
        if data['type']==typ:return data
    raise AssertionError('Did not receive '+typ)
async def wait_phase(ws, phase):
    for _ in range(15):
        s=await recv_type(ws,'room:state')
        if s['state']['phase']==phase: return s
    raise AssertionError('Missing phase '+phase)
async def send(ws,typ,**kwargs):await ws.send(json.dumps({'type':typ,**kwargs},ensure_ascii=False))

async def main():
    async with websockets.connect(URL) as a, websockets.connect(URL) as b:
        await send(a,'room:create',name='ملك',avatar='🦊')
        a0=await recv_type(a,'room:welcome');assert len(a0['state']['code'])==6
        code=a0['state']['code']; a_id=a0['id'];assert a0['state']['host']==a_id
        await send(b,'room:join',code=code,name='بطلة',avatar='🦄')
        b0=await recv_type(b,'room:welcome');b_id=b0['id']
        assert len(b0['state']['players'])==2
        await send(a,'room:chat',text='مرحباً 👋')
        c=await recv_type(b,'room:chat');assert c['message']['text']=='مرحباً 👋'
        await send(b,'room:start')  # nonhost should not start
        await send(a,'room:start')
        await wait_phase(a,'choice');await wait_phase(b,'choice')
        await send(a,'game:pick',category='truth')
        s=await wait_phase(a,'write');assert s['state']['judge']==b_id
        await send(a,'game:submit',ruling='not my turn') # blocked
        await send(b,'game:submit',ruling='ما أكثر شيء تحبه في المدرسة؟')
        reveal=await wait_phase(a,'reveal')
        assert reveal['state']['ruling']=='ما أكثر شيء تحبه في المدرسة؟'
        await send(a,'game:complete',result='done')
        n=await wait_phase(a,'choice')
        assert n['state']['phase']=='choice' and n['state']['active']==b_id
        assert n['state']['players'][0]['score']==10
        await send(a,'room:end')
        end=await wait_phase(a,'results')
    print('PASS: room code, live join, chat, permissions, secret verdict, synchronized reveal, points, next turn, results.')

asyncio.run(main())
