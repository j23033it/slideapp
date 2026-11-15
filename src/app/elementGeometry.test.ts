import { describe, expect, it } from 'vitest'
import { limitBoxPosition, toSlideRect } from './elementGeometry'

describe('box geometry', () => {
  it('keeps sixteen slide pixels visible at every edge', () => {
    expect(limitBoxPosition({left:-1000,top:-1000,width:200}, 80, 1280, 720)).toEqual({left:-184,top:-64,width:200})
    expect(limitBoxPosition({left:3000,top:3000,width:200}, 80, 1280, 720)).toEqual({left:1264,top:704,width:200})
  })
  it('converts scaled viewport coordinates into slide pixels', () => {
    const frame = {left:100,top:50,width:640,height:360} as DOMRect
    const rect = {left:260,top:170,width:200,height:50} as DOMRect
    expect(toSlideRect(rect, frame, 1280, 720)).toEqual({x:320,y:240,width:400,height:100,scaleX:0.5,scaleY:0.5})
  })
})
