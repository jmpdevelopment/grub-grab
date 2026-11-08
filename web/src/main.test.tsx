import { screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { fakeFetch } from './test/fakes'

it('mounts the app into #root', async () => {
  fakeFetch({ 'GET /config.json': () => new Response('', { status: 404 }) })
  const root = document.createElement('div')
  root.id = 'root'
  document.body.append(root)

  await import('./main')

  expect(await screen.findByText('No recipes yet.')).toBeInTheDocument()
  expect(root).not.toBeEmptyDOMElement()
})
