import { Module } from '@nestjs/common';
import { EngagementsController } from './engagements.controller.js';

@Module({ controllers: [EngagementsController] })
export class EngagementsModule {}
