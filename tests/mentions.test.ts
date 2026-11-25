import { describe, expect, it } from 'vitest'
import { findMention, insertMention, matchUsers, mergeSuggestions } from '../src/renderer/src/mentions'

describe('findMention', () => {
  it('detects the token being typed', () => {
    expect(findMention('Thanks @bag', 11)).toEqual({ start: 7, query: 'bag' })
    expect(findMention('@', 1)).toEqual({ start: 0, query: '' })
    expect(findMention('cc (@will', 9)).toEqual({ start: 4, query: 'will' })
    expect(findMention('line one\n@ma', 12)).toEqual({ start: 9, query: 'ma' })
  })

  it('ignores emails, finished mentions and code', () => {
    expect(findMention('mail me@example', 15)).toBeNull()
    expect(findMention('hi @bag done', 12)).toBeNull()
    expect(findMention('`@decorator', 11)).toBeNull()
    expect(findMention('@@x', 3)).toBeNull()
  })
})

describe('insertMention', () => {
  it('replaces the partial login and adds a space', () => {
    expect(insertMention('Thanks @bag', 7, 11, 'BagToad')).toEqual({ text: 'Thanks @BagToad ', caret: 16 })
  })
  it('completes a token the caret is inside of without doubling spaces', () => {
    expect(insertMention('ping @wi please', 5, 8, 'williammartin')).toEqual({ text: 'ping @williammartin please', caret: 20 })
    expect(insertMention('ping @wixyz please', 5, 8, 'williammartin')).toEqual({ text: 'ping @williammartin please', caret: 20 })
  })
})

describe('matching', () => {
  const users = [{ login: 'williammartin', name: 'William Martin' }, { login: 'BagToad', name: 'Kynan Ware' }, { login: 'swilliams' }]
  it('ranks prefix matches first, then names, then substrings', () => {
    expect(matchUsers(users, 'wil').map((u) => u.login)).toEqual(['williammartin', 'swilliams'])
    expect(matchUsers(users, 'kyn').map((u) => u.login)).toEqual(['BagToad'])
    expect(matchUsers(users, '').length).toBe(3)
  })
  it('puts participants before remote results without duplicates', () => {
    const merged = mergeSuggestions([{ login: 'BagToad', participant: true }], [{ login: 'bagtoad', avatarUrl: 'a', name: 'Kynan' }, { login: 'bagel', avatarUrl: 'b' }])
    expect(merged).toEqual([{ login: 'BagToad', participant: true, name: 'Kynan', avatarUrl: 'a' }, { login: 'bagel', avatarUrl: 'b' }])
  })
})
