import * as v from 'valibot'

function createTenantURLSchemaEntry(): {
  tenantUrl: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.UrlAction<string, undefined>, v.DescriptionAction<string, 'The Cumulocity tenant URL against which the operation is executed.'>, v.ExamplesAction<string, readonly ['https://my-tenant.cumulocity.com', 'https://tenantName.acme.com']>]>
} {
  return {
    tenantUrl: v.pipe(v.string(), v.url(), v.description('The Cumulocity tenant URL against which the operation is executed.'), v.examples(['https://my-tenant.cumulocity.com', 'https://tenantName.acme.com'])),
  }
}

type SchemaWithTenantURL<TSchema extends v.ObjectSchema<v.ObjectEntries, any>> = v.UnionSchema<[TSchema, v.ObjectSchema<TSchema['entries'] & ReturnType<typeof createTenantURLSchemaEntry>, TSchema['message']>], undefined>

export function addTenantURLToSchema<TSchema extends v.ObjectSchema<v.ObjectEntries, any>>(schema: TSchema): SchemaWithTenantURL<TSchema> {
  const executionEnvironment = globalThis.executionEnvironment
  // if the execution environment is cli, the have to add the tenantUrl to the schema
  if (executionEnvironment === 'cli') {
    return v.object({
      ...schema.entries,
      ...createTenantURLSchemaEntry(),
    }) as any as SchemaWithTenantURL<TSchema>
  }
  return schema as any as SchemaWithTenantURL<TSchema>
}
