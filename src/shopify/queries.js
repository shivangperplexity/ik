'use strict';

// GraphQL Admin API documents. Only order/fulfillment/product data is
// requested; no customer name, address, email or phone is ever fetched.

const ORDER_FIELDS = `
  id
  name
  createdAt
  cancelledAt
  closed
  displayFulfillmentStatus
  fulfillmentOrders(first: 20) {
    nodes {
      id
      status
      lineItems(first: 100) {
        nodes {
          id
          remainingQuantity
          sku
          variant {
            id
            title
            barcode
            media(first: 1) { nodes { preview { image { url } } } }
            product { id title featuredMedia { preview { image { url } } } }
          }
          lineItem {
            id
            title
            variantTitle
            image { url }
          }
        }
      }
    }
  }
`;

// Light-weight list for the queue screen. Shopify rejects queries whose
// *requested* cost exceeds 1000 points, so page size and nesting are kept
// small and literal; full line details are fetched per order when picking.
const QUEUE_QUERY = `
  query PickQueue($after: String, $query: String!) {
    orders(first: 25, after: $after, sortKey: CREATED_AT, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        createdAt
        cancelledAt
        closed
        displayFulfillmentStatus
        fulfillmentOrders(first: 5) {
          nodes {
            status
            lineItems(first: 25) {
              nodes {
                remainingQuantity
                sku
                variant { id barcode }
                lineItem { id }
              }
            }
          }
        }
      }
    }
  }
`;

const ORDER_BY_NAME_QUERY = `
  query OrderByName($query: String!) {
    orders(first: 5, query: $query) {
      nodes { id name }
    }
  }
`;

const ORDER_BY_ID_QUERY = `
  query OrderById($id: ID!) {
    order(id: $id) { ${ORDER_FIELDS} }
  }
`;

const VARIANTS_QUERY = `
  query VariantsPage($after: String) {
    productVariants(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        sku
        barcode
        media(first: 1) { nodes { preview { image { url } } } }
        product {
          id
          title
          status
          featuredMedia { preview { image { url } } }
        }
      }
    }
  }
`;

const TAGS_ADD_MUTATION = `
  mutation AddTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

const SHOP_QUERY = `query ShopInfo { shop { name myshopifyDomain } }`;

// Orders that still need physical picking. Cancelled/closed orders are
// additionally filtered in code.
const QUEUE_SEARCH = 'status:open AND (fulfillment_status:unfulfilled OR fulfillment_status:partial)';

module.exports = {
  QUEUE_QUERY,
  ORDER_BY_NAME_QUERY,
  ORDER_BY_ID_QUERY,
  VARIANTS_QUERY,
  TAGS_ADD_MUTATION,
  SHOP_QUERY,
  QUEUE_SEARCH,
};
