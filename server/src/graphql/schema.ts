import { builder } from './builder.js'
import './inputs.js'
import './types.js'
import './queries.js'
import './mutations.js'
import './annotation-mutations.js'

export const schema = builder.toSchema({ sortSchema: true })
