// Open Telemetry (optional)
const { ApolloOpenTelemetry } = require('supergraph-demo-opentelemetry');

const { mapSchema, getDirective, MapperKind } = require('@graphql-tools/utils');
const { defaultFieldResolver } = require('graphql');

const { Oso } = require('oso-cloud');

const oso = new Oso("https://cloud.osohq.com", process.env["OSO_AUTH"]);

// This function takes in a schema and adds authz
// to every resolver for an object field that has a directive with
// the specified name (we're using `upper`)
function authzDirectiveTransformer(schema) {
    const typeDirectiveArgumentMaps = {}
    return mapSchema(schema, {
        [MapperKind.TYPE]: type => {
            const authzDirective = getDirective(schema, type, "authz")?.[0]
            if (authzDirective) {
                typeDirectiveArgumentMaps[type.name] = authzDirective
            }
            return undefined
        },
        [MapperKind.OBJECT_FIELD]: (fieldConfig, _fieldName, typeName) => {
            const authzDirective =
                getDirective(schema, fieldConfig, "authz")?.[0] ?? typeDirectiveArgumentMaps[typeName]
            if (authzDirective) {
                const { permission, resource } = authzDirective;
                const resourceType = resource || typeName;
                const { resolve = defaultFieldResolver } = fieldConfig
                fieldConfig.resolve = async function (source, args, context, info) {
                    console.log("authz", source, args, context);
                    const resourceId = (resource == typeName) ? args.id : context[resourceType].id;
                    const userId = context.userId;
                    if (!userId) {
                        throw new Error("need to log in");
                    }
                    if (!(await oso.authorize({ "type": "User", "id": userId }, permission, { "type": resourceType, "id": resourceId }))) {
                        throw new Error("not allowed");
                    }
                    return resolve(source, args, context, info)
                }
                return fieldConfig
            }
        }
    })
}

if (process.env.APOLLO_OTEL_EXPORTER_TYPE) {
    new ApolloOpenTelemetry({
        type: 'subgraph',
        name: 'products',
        exporter: {
            type: process.env.APOLLO_OTEL_EXPORTER_TYPE, // console, zipkin, collector
            host: process.env.APOLLO_OTEL_EXPORTER_HOST,
            port: process.env.APOLLO_OTEL_EXPORTER_PORT,
        }
    }).setupInstrumentation();
}

const { ApolloServer, gql } = require('apollo-server');
const { buildSubgraphSchema } = require('@apollo/subgraph');
const { readFileSync } = require('fs');

const port = process.env.APOLLO_PORT || 4000;

// Data sources
const products = [
    { id: 'converse-1', sku: 'converse-1', package: 'converse', name: 'Converse Chuck Taylor', oldField: 'deprecated' },
    { id: 'vans-1', sku: 'vans-1', package: 'vans', name: 'Vans Classic Sneaker', oldField: 'deprecated' },
]

const variationByProduct = [
    { id: 'converse-1', variation: { id: 'converse-classic', name: 'Converse Chuck Taylor' } },
    { id: 'vans-1', variation: { id: 'vans-classic', name: 'Vans Classic Sneaker' } },
]

const userByProduct = [
    { id: 'converse-1', user: { email: 'info@converse.com', totalProductsCreated: 1099 } },
    { id: 'vans-1', user: { email: 'info@vans.com', totalProductsCreated: 1099 } },
]

// GraphQL
const typeDefs = gql(readFileSync('./products.graphql', { encoding: 'utf-8' }));
const resolvers = {
    Query: {
        allProducts: (_, args, context) => {
            return products;
        },
        product: (_, args, context) => {
            return products.find(p => p.id == args.id);
        }
    },
    Mutation: {
        product: (parent, args, context) => {
            console.log("product", parent, args, context)
            const p = products.find(p => p.id == args.id);
            context["Product"] = p;
            return p;
        }
    },
    ProductMutation: {
        changeName: (parent, args, context) => {
            console.log("change name", parent, args, context)
            parent.name = args.name;
            return parent.name
        }
    },
    ProductItf: {
        __resolveType(obj, context, info) {
            return 'Product';
        },
    },
    Product: {
        variation: (reference) => {
            return new Promise(r => setTimeout(() => {
                if (reference.id) {
                    const variation = variationByProduct.find(p => p.id == reference.id).variation;
                    r(variation);
                }
                r({ id: 'defaultVariation', name: 'default variation' });
            }, 1000));
        },
        dimensions: () => {
            return { size: "1", weight: 1 }
        },
        createdBy: (reference) => {
            if (reference.id) {
                return userByProduct.find(p => p.id == reference.id).user;
            }
            return null;
        },
        reviewsScore: () => {
            return 4.5;
        },
        __resolveReference: (reference) => {
            if (reference.id) return products.find(p => p.id == reference.id);
            else if (reference.sku && reference.package) return products.find(p => p.sku == reference.sku && p.package == reference.package);
            else return { id: 'rover', package: '@apollo/rover', ...reference };
        }
    }
}
const server = new ApolloServer(
    {
        schema: authzDirectiveTransformer(buildSubgraphSchema({ typeDefs, resolvers })),
        context: ({ req }) => {
            // console.log(req)
            const userId = req.headers['x-user-id'] || '';
            // Add the user to the context
            return { userId };

        },
    });
server.listen({ port: port }).then(({ url }) => {
    console.log(`🚀 Products subgraph ready at ${url}`);
}).catch(err => { console.error(err) });
