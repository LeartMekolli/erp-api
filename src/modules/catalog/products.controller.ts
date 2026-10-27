import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema, paginationQuerySchema } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { categoryResponseSchema, productResponseSchema } from './product-response';
import type { CategoryResponse, ProductResponse } from './product-response';
import {
  ProductsService,
  assemblyPartsSchema,
  createCategorySchema,
  createProductSchema,
  designFileSchema,
  productOptionsInputSchema,
  updateProductSchema,
} from './products.service';

const idSchema = z.uuid();

/** Categories and products (Catalog spec C2, C3, C4, B1). */
@Controller('catalog')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @ApiDoc({
    summary: 'Create a category and the measures its design files must have.',
    description: '`required_measures` are measure types such as `volume` or `bounding_box_x`. A key already in use is a 409.',
    body: createCategorySchema,
    response: categoryResponseSchema,
    errors: [400],
  })
  @RequirePermission('catalog.write')
  @Post('categories')
  createCategory(
    @CurrentTenant() tenantId: string,
    @Body(new ZodValidationPipe(createCategorySchema)) body: z.infer<typeof createCategorySchema>,
  ): Promise<CategoryResponse> {
    return this.products.createCategory(tenantId, body);
  }

  @ApiDoc({
    summary: 'Every category.',
    response: z.strictObject({ data: z.array(categoryResponseSchema) }),
  })
  @RequirePermission('catalog.read')
  @Get('categories')
  async listCategories(@CurrentTenant() tenantId: string): Promise<{ data: CategoryResponse[] }> {
    return { data: await this.products.listCategories(tenantId) };
  }

  @ApiDoc({
    summary: 'Create a custom, ready-made or assembly product with how it can be sized.',
    description:
      '`custom`: the customer brings the design file. `ready_made`: the product pins its own measured file through ' +
      '`PUT /catalog/products/{id}/design-file`. `assembly`: made of ready-made parts (`PUT /catalog/products/{id}/parts`), ' +
      'with no design file and `sizing: none`, never a customer\'s own. `sizing` is `none`, a `range` of scale factors (`min` < `max`), or ' +
      '`named` sizes each with a scale; scales are decimal strings from 0.01 to 100. `material_id` fixes the material; ' +
      'without it, an option value selects one. A key already in use is a 409.',
    body: createProductSchema,
    response: productResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('catalog.write')
  @Post('products')
  create(
    @CurrentTenant() tenantId: string,
    @Body(new ZodValidationPipe(createProductSchema)) body: z.infer<typeof createProductSchema>,
  ): Promise<ProductResponse> {
    return this.products.create(tenantId, body);
  }

  @ApiDoc({
    summary: 'List products with their options and design file, newest first.',
    query: paginationQuerySchema,
    response: pageSchema(productResponseSchema),
    errors: [400],
  })
  @RequirePermission('catalog.read')
  @Get('products')
  list(
    @CurrentTenant() tenantId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: z.infer<typeof paginationQuerySchema>,
  ): Promise<Page<ProductResponse>> {
    return this.products.list(tenantId, query);
  }

  @ApiDoc({
    summary: 'A product with its options and design file.',
    response: productResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('catalog.read')
  @Get('products/:id')
  get(@CurrentTenant() tenantId: string, @Param('id', new ZodValidationPipe(idSchema)) id: string): Promise<ProductResponse> {
    return this.products.get(tenantId, id);
  }

  @ApiDoc({
    summary: "Change a product's name, category, sizing or fixed material.",
    description:
      'Key and kind stay as created. Moving a ready-made product to a category whose required measures its design ' +
      'file lacks is a 409.',
    body: updateProductSchema,
    response: productResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('catalog.write')
  @Patch('products/:id')
  update(
    @CurrentTenant() tenantId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: z.infer<typeof updateProductSchema>,
  ): Promise<ProductResponse> {
    return this.products.update(tenantId, id, body);
  }

  @ApiDoc({
    summary: 'Replace the option groups a product offers, with the values it allows and their defaults.',
    description:
      'Each group lists the values it allows from that group; a default must be one of them. An empty `groups` ' +
      'removes every option.',
    body: productOptionsInputSchema,
    response: productResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('catalog.write')
  @Put('products/:id/options')
  setOptions(
    @CurrentTenant() tenantId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(productOptionsInputSchema)) body: z.infer<typeof productOptionsInputSchema>,
  ): Promise<ProductResponse> {
    return this.products.setOptions(tenantId, id, body);
  }

  @ApiDoc({
    summary: "Replace an assembly's parts, each with how many go into one assembly and the size it is made at.",
    description:
      'Every part is a shared ready-made product, so never an assembly itself (one level only), listed once, at a ' +
      'size its sizing offers; omit `size` for the part as it is. The options chosen on the assembly pass to every ' +
      'part offering the same option group. A product that is not an assembly is a 400.',
    body: assemblyPartsSchema,
    response: productResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('catalog.write')
  @Put('products/:id/parts')
  setParts(
    @CurrentTenant() tenantId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(assemblyPartsSchema)) body: z.infer<typeof assemblyPartsSchema>,
  ): Promise<ProductResponse> {
    return this.products.setParts(tenantId, id, body);
  }

  @ApiDoc({
    summary: "Pin a measured design file version as a ready-made product's own file.",
    description:
      'A 409 when the product is custom, the file is not a design, the version is not measured yet, or it lacks a ' +
      "measure the product's category requires. A later upload never changes the product until it is pinned again.",
    body: designFileSchema,
    response: productResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('catalog.write')
  @Put('products/:id/design-file')
  setDesignFile(
    @CurrentTenant() tenantId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(designFileSchema)) body: z.infer<typeof designFileSchema>,
  ): Promise<ProductResponse> {
    return this.products.setDesignFile(tenantId, id, body);
  }
}
