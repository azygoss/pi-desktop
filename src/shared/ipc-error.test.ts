import { describe, expect, it } from 'vitest'

import { ipcErrorMessage } from './ipc-error'

describe('ipcErrorMessage', () => {
  it('strips the Electron invoke prefix from an Error message', () => {
    const e = new Error(
      "Error invoking remote method 'pi-desktop:chat:send': Error: synthetic failure"
    )
    expect(ipcErrorMessage(e)).toBe('synthetic failure')
  })

  it('strips the prefix when the inner message is not Error-typed', () => {
    expect(ipcErrorMessage("Error invoking remote method 'x:y': plain reason")).toBe('plain reason')
  })

  it('passes plain Error messages through', () => {
    expect(ipcErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('accepts a string error and strips the prefix', () => {
    expect(ipcErrorMessage("Error invoking remote method 'x:y': Error: nope")).toBe('nope')
  })

  it('falls back for non-Error non-string values', () => {
    expect(ipcErrorMessage(undefined)).toBe('Something went wrong')
    expect(ipcErrorMessage(null, 'custom')).toBe('custom')
    expect(ipcErrorMessage(42, 'custom')).toBe('custom')
  })
})
